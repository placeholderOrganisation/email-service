import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { Email } from "../models/Email.js";
import { Form } from "../models/Form.js";
import { Project } from "../models/Project.js";
import { generateApiKey } from "../utils/apiKey.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../test/mongo.js";

const app = createApp();
const FORM_ID = "frm_test123";
const ORIGIN = "https://minteksoftware.com";

beforeAll(async () => {
  await connectMemoryMongo();
});
afterAll(async () => {
  await disconnectMemoryMongo();
});

beforeEach(async () => {
  await clearDatabase();
  const key = generateApiKey();
  const project = await Project.create({
    name: "Project X",
    fromAddress: "projectx@minteksoftware.com",
    fromName: "Project X",
    apiKeyHash: key.hash,
    apiKeyLast4: key.last4,
  });
  await Form.create({
    projectId: project._id,
    formId: FORM_ID,
    name: "Contact form",
    toAddress: "owner@minteksoftware.com",
    allowedOrigins: [ORIGIN],
  });
});

const submit = () => request(app).post(`/v1/forms/${FORM_ID}/submit`).set("Origin", ORIGIN);

describe("POST /v1/forms/:formId/submit", () => {
  it("enqueues a notification to the owner with the submitter as Reply-To (no API key)", async () => {
    const res = await submit().send({
      name: "Sam",
      email: "lead@example.com",
      message: "I need a website",
      fields: { projectType: "Web app", budget: "$5k" },
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });

    const emails = await Email.find({});
    expect(emails).toHaveLength(1);
    expect(emails[0].to).toBe("owner@minteksoftware.com");
    expect(emails[0].from).toBe("Project X <projectx@minteksoftware.com>");
    expect(emails[0].replyTo).toBe("lead@example.com");
    expect(emails[0].templateName).toBe("contact-notification");
    expect((emails[0].variables as Record<string, unknown>).projectType).toBe("Web app");
  });

  it("silently drops honeypot submissions", async () => {
    const res = await submit().send({
      name: "Bot",
      email: "bot@spam.com",
      message: "spam",
      _gotcha: "i am a bot",
    });
    expect(res.status).toBe(200);
    expect(await Email.countDocuments({})).toBe(0);
  });

  it("rejects a disallowed origin", async () => {
    const res = await request(app)
      .post(`/v1/forms/${FORM_ID}/submit`)
      .set("Origin", "https://evil.com")
      .send({ name: "Sam", email: "lead@example.com", message: "hi" });
    expect(res.status).toBe(403);
    expect(await Email.countDocuments({})).toBe(0);
  });

  it("rejects an invalid payload", async () => {
    const res = await submit().send({ name: "Sam", email: "not-an-email", message: "hi" });
    expect(res.status).toBe(400);
  });

  it("404s an unknown form", async () => {
    const res = await request(app)
      .post("/v1/forms/frm_nope/submit")
      .set("Origin", ORIGIN)
      .send({ name: "Sam", email: "lead@example.com", message: "hi" });
    expect(res.status).toBe(404);
  });

  it("also sends an acknowledgment when the form enables it", async () => {
    await Form.updateOne({ formId: FORM_ID }, { ackTemplate: "contact-acknowledgment" });
    const res = await submit().send({ name: "Sam", email: "lead@example.com", message: "hi" });
    expect(res.status).toBe(200);

    const emails = await Email.find({}).sort({ to: 1 });
    expect(emails).toHaveLength(2);
    expect(emails.map((e) => e.to).sort()).toEqual([
      "lead@example.com",
      "owner@minteksoftware.com",
    ]);
  });
});
