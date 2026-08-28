import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { Email } from "../models/Email.js";
import { Project } from "../models/Project.js";
import { generateApiKey } from "../utils/apiKey.js";
import { drainOnce } from "../worker/emailWorker.js";
import type { OutgoingMessage, Provider } from "../providers/index.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../test/mongo.js";

const app = createApp();

let apiKey: string;

/** Records what it was asked to send so tests can assert the rendered message. */
function recordingProvider(): Provider & { sent: OutgoingMessage[] } {
  const sent: OutgoingMessage[] = [];
  return {
    name: "fake",
    sent,
    async send(msg) {
      sent.push(msg);
      return { messageId: `fake-${sent.length}` };
    },
    close: vi.fn(),
  };
}

/** A provider that always rejects with the given SMTP response code. */
function rejectingProvider(responseCode: number): Provider {
  return {
    name: "fake",
    async send() {
      throw Object.assign(new Error(`SMTP ${responseCode}`), { responseCode });
    },
    close: vi.fn(),
  };
}

const auth = () => ({ Authorization: `Bearer ${apiKey}` });

beforeAll(async () => {
  await connectMemoryMongo();
});

afterAll(async () => {
  await disconnectMemoryMongo();
});

beforeEach(async () => {
  await clearDatabase();
  const key = generateApiKey();
  apiKey = key.plaintext;
  await Project.create({
    name: "Project X",
    fromAddress: "projectx@minteksoftware.com",
    fromName: "Project X",
    apiKeyHash: key.hash,
    apiKeyLast4: key.last4,
  });
});

describe("auth", () => {
  it("rejects requests without an API key", async () => {
    const res = await request(app).post("/v1/send").send({ to: "u@e.com", text: "hi" });
    expect(res.status).toBe(401);
  });
});

describe("POST /v1/send", () => {
  it("enqueues, sends via the worker, and applies the project's from address", async () => {
    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "user@example.com", subject: "Hi", markdown: "# Welcome\n\n**hi**" });

    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    const provider = recordingProvider();
    const processed = await drainOnce([provider]);
    expect(processed).toBe(1);

    // The rendered message: markdown -> html, from = project's own sender.
    expect(provider.sent[0].from).toBe("Project X <projectx@minteksoftware.com>");
    expect(provider.sent[0].html).toContain("<strong>hi</strong>");

    const status = await request(app).get(`/v1/emails/${res.body.id}`).set(auth());
    expect(status.body.status).toBe("sent");
    expect(status.body.provider).toBe("fake");
  });

  it("passes replyTo through to the outgoing message", async () => {
    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "owner@mintek.com", replyTo: "lead@example.com", subject: "New enquiry", text: "hi" });
    expect(res.status).toBe(202);

    const provider = recordingProvider();
    await drainOnce([provider]);
    expect(provider.sent[0].replyTo).toBe("lead@example.com");
  });

  it("ignores a caller-supplied from address", async () => {
    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "user@example.com", subject: "Hi", text: "hi", from: "evil@spoof.com" });

    expect(res.status).toBe(202);
    const email = await Email.findById(res.body.id);
    expect(email!.from).toBe("Project X <projectx@minteksoftware.com>");
  });

  it("rejects an invalid payload (no content)", async () => {
    const res = await request(app).post("/v1/send").set(auth()).send({ to: "user@example.com" });
    expect(res.status).toBe(400);
  });

  it("dedupes by Idempotency-Key", async () => {
    const body = { to: "user@example.com", subject: "Hi", text: "hi" };
    const first = await request(app).post("/v1/send").set(auth()).set("Idempotency-Key", "abc").send(body);
    const second = await request(app).post("/v1/send").set(auth()).set("Idempotency-Key", "abc").send(body);

    expect(first.body.id).toBe(second.body.id);
    expect(await Email.countDocuments({})).toBe(1);
  });
});

describe("worker error handling", () => {
  it("marks a permanent (5xx) failure terminal without retrying", async () => {
    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "bounce@example.com", subject: "Hi", text: "hi" });

    await drainOnce([rejectingProvider(550)]);

    const email = await Email.findById(res.body.id);
    expect(email!.status).toBe("failed");
    expect(email!.attempts).toBe(3); // jumped to max — not re-eligible
    expect(email!.lastError).toContain("permanent");
  });

  it("schedules a retry on a transient failure", async () => {
    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "user@example.com", subject: "Hi", text: "hi" });

    await drainOnce([rejectingProvider(421)]);

    const email = await Email.findById(res.body.id);
    expect(email!.status).toBe("failed");
    expect(email!.attempts).toBe(1);
    expect(email!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("templates", () => {
  it("creates a template and sends by name", async () => {
    await request(app)
      .post("/v1/templates")
      .set(auth())
      .send({ name: "welcome", subject: "Hi {{name}}", format: "markdown", body: "Hello **{{name}}**" })
      .expect(201);

    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({ to: "user@example.com", templateName: "welcome", variables: { name: "Sam" } });
    expect(res.status).toBe(202);

    const provider = recordingProvider();
    await drainOnce([provider]);
    expect(provider.sent[0].subject).toBe("Hi Sam");
    expect(provider.sent[0].html).toContain("<strong>Sam</strong>");
  });

  it("sends the BookMe staff booking confirmation starter template", async () => {
    const { templateGroups } = await import("../scripts/starterTemplates.js");
    const def = templateGroups.booking.find((t) => t.name === "booking-staff-confirmation");
    expect(def).toBeDefined();

    await request(app).post("/v1/templates").set(auth()).send(def).expect(201);

    const res = await request(app)
      .post("/v1/send")
      .set(auth())
      .send({
        to: "jordan@example.com",
        templateName: "booking-staff-confirmation",
        replyTo: "ada@example.com",
        variables: {
          recipientName: "Jordan",
          customerName: "Ada",
          customerEmail: "ada@example.com",
          customerPhone: "555-0100",
          serviceName: "Haircut",
          staffName: "Jordan",
          businessName: "Test Cuts",
          when: "Monday, Aug 10 2026 at 9:00 AM",
          timezone: "America/New_York",
          duration: "30 minutes",
          notes: "**Notes:** Side door.",
          dashboardUrl: "https://bookme.example/dashboard",
        },
      });
    expect(res.status).toBe(202);

    const provider = recordingProvider();
    await drainOnce([provider]);
    expect(provider.sent[0].subject).toBe("New booking: Haircut with Ada");
    expect(provider.sent[0].html).toContain("Ada");
    expect(provider.sent[0].html).toContain("ada@example.com");
    expect(provider.sent[0].replyTo).toBe("ada@example.com");
  });
});
