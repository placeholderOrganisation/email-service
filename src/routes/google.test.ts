import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { env } from "../config/env.js";
import { GoogleConnection } from "../models/GoogleConnection.js";
import { Project } from "../models/Project.js";
import { Review } from "../models/Review.js";
import { GoogleApiError, setGoogleClientForTests } from "../services/google/client.js";
import { storeGoogleConnection } from "../services/google/connection.js";
import { syncProject } from "../services/google/sync.js";
import { generateApiKey } from "../utils/apiKey.js";
import { decrypt } from "../utils/crypto.js";
import { ACCOUNT, LOCATION, apiReview, createFakeGoogle, type FakeGoogle } from "../test/fakeGoogle.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../test/mongo.js";

const app = createApp();
const adminHeaders = () => ({ "X-Admin-Token": "test-admin-token" });

let fake: FakeGoogle;
let projectId: string;
let apiKey: string;
const originalClientId = env.google.clientId;

async function makeProject(name: string) {
  const key = generateApiKey();
  const project = await Project.create({ name, apiKeyHash: key.hash, apiKeyLast4: key.last4 });
  return { id: project._id.toString(), key: key.plaintext };
}

async function connect() {
  await storeGoogleConnection({ refreshToken: "rt-plain", email: "operator@example.com", scopes: [] });
}

function linkProject(id = projectId, locationName = LOCATION) {
  return request(app)
    .put(`/admin/api/projects/${id}/google`)
    .set(adminHeaders())
    .send({ accountName: ACCOUNT, locationName, locationTitle: "Alpha Co Downtown", syncEnabled: true });
}

/** Linked project + one synced review with an approved AI reply. */
async function syncedApprovedReview(): Promise<string> {
  await connect();
  await linkProject();
  fake.reviews = [apiReview("r1")];
  await syncProject(projectId);
  const review = await Review.findOne({ projectId });
  await request(app).post(`/admin/api/reviews/${review!._id}/reply/approve`).set(adminHeaders()).expect(200);
  return String(review!._id);
}

/** A manually imported (not API-linked) review, approved. */
async function manualApprovedReview(): Promise<string> {
  const res = await request(app)
    .post(`/admin/api/projects/${projectId}/reviews`)
    .set(adminHeaders())
    .send({ author: { name: "Manual Mary" }, rating: 4, text: "Nice", source: "google", externalReviewId: "maps-xyz" });
  const id = res.body.created[0].id as string;
  await request(app).post(`/admin/api/reviews/${id}/reply/approve`).set(adminHeaders()).expect(200);
  return id;
}

async function startConnect(): Promise<string> {
  const res = await request(app).post("/admin/api/google/connect").set(adminHeaders()).send({});
  expect(res.status).toBe(200);
  return new URL(res.body.url).searchParams.get("state")!;
}

beforeAll(async () => {
  await connectMemoryMongo();
});
afterAll(async () => {
  setGoogleClientForTests(null);
  await disconnectMemoryMongo();
});
beforeEach(async () => {
  await clearDatabase();
  fake = createFakeGoogle();
  setGoogleClientForTests(fake.client);
  const p = await makeProject("Alpha Co");
  projectId = p.id;
  apiKey = p.key;
});
afterEach(() => {
  env.google.clientId = originalClientId;
});

describe("Google OAuth", () => {
  it("connect returns Google's consent URL with a stored single-use state", async () => {
    const res = await request(app).post("/admin/api/google/connect").set(adminHeaders()).send({});
    const url = new URL(res.body.url);
    expect(url.host).toBe("accounts.google.com");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    const conn = await GoogleConnection.findOne();
    expect(conn!.oauthState).toBe(state);
    expect(conn!.oauthStateExpiresAt!.getTime()).toBeGreaterThan(Date.now() + 9 * 60_000);
  });

  it("connect is a clean 400 when Google is not configured", async () => {
    env.google.clientId = "";
    const res = await request(app).post("/admin/api/google/connect").set(adminHeaders()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not configured/);
    const status = await request(app).get("/admin/api/google/status").set(adminHeaders());
    expect(status.body.configured).toBe(false);
  });

  it("callback rejects a missing or wrong state without exchanging the code", async () => {
    await startConnect();
    const missing = await request(app).get("/admin/google/callback?code=abc");
    expect(missing.status).toBe(400);
    const wrong = await request(app).get(`/admin/google/callback?code=abc&state=${"0".repeat(64)}`);
    expect(wrong.status).toBe(400);
    expect(wrong.text).toContain("invalid, expired, or already used");
    expect(fake.exchangeCalls).toHaveLength(0);
  });

  it("callback rejects an expired state", async () => {
    const state = await startConnect();
    await GoogleConnection.updateOne({}, { $set: { oauthStateExpiresAt: new Date(Date.now() - 1000) } });
    const res = await request(app).get(`/admin/google/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    expect(fake.exchangeCalls).toHaveLength(0);
  });

  it("callback success stores an ENCRYPTED token, redirects, and the state cannot be reused", async () => {
    const state = await startConnect();
    const res = await request(app).get(`/admin/google/callback?code=auth-code&state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe("/admin");
    expect(fake.exchangeCalls).toEqual(["auth-code"]);

    const raw = await GoogleConnection.collection.findOne({});
    const plaintext = fake.exchange.refreshToken!;
    expect(raw!.refreshTokenEnc).toBeTruthy();
    expect(raw!.refreshTokenEnc).not.toContain(plaintext);
    expect(JSON.stringify(raw)).not.toContain(plaintext);
    expect(decrypt(raw!.refreshTokenEnc)).toBe(plaintext);
    expect(raw!.email).toBe("operator@example.com");
    expect(raw!.oauthState).toBeUndefined();

    const reused = await request(app).get(`/admin/google/callback?code=auth-code&state=${state}`);
    expect(reused.status).toBe(400);
    expect(fake.exchangeCalls).toHaveLength(1);
  });

  it("callback explains how to recover when Google returns no refresh token", async () => {
    fake.exchange = { ...fake.exchange, refreshToken: undefined };
    const state = await startConnect();
    const res = await request(app).get(`/admin/google/callback?code=c&state=${state}`);
    expect(res.status).toBe(400);
    expect(res.text).toContain("myaccount.google.com/permissions");
    expect(await GoogleConnection.exists({ refreshTokenEnc: { $type: "string" } })).toBeNull();
  });

  it("status reports the connection and never leaks the token or state", async () => {
    const state = await startConnect();
    await request(app).get(`/admin/google/callback?code=c&state=${state}`).expect(302);
    await startConnect(); // a pending state exists too

    const res = await request(app).get("/admin/api/google/status").set(adminHeaders());
    expect(res.body).toMatchObject({ configured: true, connected: true, email: "operator@example.com", lastError: null });
    const raw = await GoogleConnection.collection.findOne({});
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(fake.exchange.refreshToken!);
    expect(text).not.toContain(raw!.refreshTokenEnc);
    expect(text).not.toContain(raw!.oauthState);
    expect(Object.keys(res.body).sort()).toEqual(["configured", "connected", "connectedAt", "email", "lastError"]);
  });

  it("disconnect revokes (best-effort) and forgets the connection", async () => {
    await connect();
    const res = await request(app).post("/admin/api/google/disconnect").set(adminHeaders()).send({});
    expect(res.status).toBe(200);
    expect(fake.revokeCalls).toBe(1);
    const status = await request(app).get("/admin/api/google/status").set(adminHeaders());
    expect(status.body.connected).toBe(false);
  });
});

describe("Google locations + project linking", () => {
  it("lists flattened locations with linkedProjectId", async () => {
    await connect();
    await linkProject().expect(200);
    const res = await request(app).get("/admin/api/google/locations").set(adminHeaders());
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(2);
    expect(res.body[0]).toMatchObject({
      accountName: ACCOUNT,
      accountDisplayName: "Operator Account",
      locationName: LOCATION,
      title: "Alpha Co Downtown",
      address: "1 Main St, Springfield, IL",
      placeId: "place-alpha",
      linkedProjectId: projectId,
    });
    expect(res.body[1].linkedProjectId).toBeNull();
  });

  it("locations require a connection (409)", async () => {
    const res = await request(app).get("/admin/api/google/locations").set(adminHeaders());
    expect(res.status).toBe(409);
  });

  it("links, toggles sync, and unlinks a project", async () => {
    const linked = await linkProject();
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ linked: true, locationName: LOCATION, syncEnabled: true, running: false });

    const off = await request(app).put(`/admin/api/projects/${projectId}/google`).set(adminHeaders()).send({ syncEnabled: false });
    expect(off.body).toMatchObject({ linked: true, syncEnabled: false });

    const unlinked = await request(app).delete(`/admin/api/projects/${projectId}/google`).set(adminHeaders());
    expect(unlinked.body).toMatchObject({ linked: false, locationName: null, syncEnabled: false });

    const enable = await request(app).put(`/admin/api/projects/${projectId}/google`).set(adminHeaders()).send({ syncEnabled: true });
    expect(enable.status).toBe(409);
  });

  it("rejects linking a location already linked to another project (409)", async () => {
    await linkProject().expect(200);
    const other = await makeProject("Bravo Co");
    const res = await linkProject(other.id);
    expect(res.status).toBe(409);
    expect(res.body.error).toContain("Alpha Co");
  });

  it("validates the link body", async () => {
    const res = await request(app)
      .put(`/admin/api/projects/${projectId}/google`)
      .set(adminHeaders())
      .send({ accountName: "nope", locationName: LOCATION, syncEnabled: true });
    expect(res.status).toBe(400);
  });
});

describe("Sync now", () => {
  it("returns 202, runs in the background, and reports status/stats", async () => {
    await connect();
    await linkProject();
    fake.reviews = [apiReview("r1"), apiReview("r2", { comment: "Second" })];

    const start = await request(app).post(`/admin/api/projects/${projectId}/google/sync`).set(adminHeaders()).send({});
    expect(start.status).toBe(202);
    expect(start.body.running).toBe(true);

    let status = start.body;
    for (let i = 0; i < 100 && status.running; i++) {
      await new Promise((r) => setTimeout(r, 20));
      status = (await request(app).get(`/admin/api/projects/${projectId}/google/sync`).set(adminHeaders())).body;
    }
    expect(status).toMatchObject({ running: false, lastSyncStatus: "ok" });
    expect(status.lastSyncStats).toMatchObject({ fetched: 2, created: 2 });
    expect(await Review.countDocuments({ projectId })).toBe(2);
  });

  it("409s when a sync is already running, or the project is unlinked/disconnected", async () => {
    const unlinked = await request(app).post(`/admin/api/projects/${projectId}/google/sync`).set(adminHeaders()).send({});
    expect(unlinked.status).toBe(409);

    await linkProject();
    const disconnected = await request(app).post(`/admin/api/projects/${projectId}/google/sync`).set(adminHeaders()).send({});
    expect(disconnected.status).toBe(409);

    await connect();
    await Project.updateOne({ _id: projectId }, { $set: { "google.syncLockedAt": new Date() } });
    const running = await request(app).post(`/admin/api/projects/${projectId}/google/sync`).set(adminHeaders()).send({});
    expect(running.status).toBe(409);
    expect(running.body.error).toMatch(/already running/);
  });
});

describe("Post to Google", () => {
  it("publishes an approved, linked reply via the API", async () => {
    const id = await syncedApprovedReview();
    const review = await Review.findById(id);
    const res = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(200);
    expect(res.body.publishing).toMatchObject({ status: "posted", method: "google_api", postedBy: "operator", attempts: 0 });
    expect(res.body.publishing.error).toBeUndefined();
    expect(res.body.google.replyUpdateTime).toBe("2025-06-01T09:30:00.000Z");
    expect(fake.updateReplyCalls).toEqual([{ reviewName: `${ACCOUNT}/${LOCATION}/reviews/r1`, comment: review!.reply!.body }]);

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(queue.body.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  it("rejects an unapproved reply (400)", async () => {
    await connect();
    await linkProject();
    fake.reviews = [apiReview("r1")];
    await syncProject(projectId);
    const review = await Review.findOne({ projectId });
    const res = await request(app).post(`/admin/api/reviews/${review!._id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(400);
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("rejects a review not linked to the API (409) — HTML ids are never used", async () => {
    await connect();
    await linkProject();
    const id = await manualApprovedReview();
    const res = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Not linked to Google yet - run a sync or use Mark posted");
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("rejects a reply over 4096 bytes (400) even when under the character limit", async () => {
    const id = await syncedApprovedReview();
    await Review.updateOne({ _id: id }, { $set: { "reply.body": "é".repeat(2100) } }); // 2100 chars, 4200 bytes
    const res = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/4096 bytes/);
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("a Google failure keeps it unpublished and records the error (502)", async () => {
    const id = await syncedApprovedReview();
    fake.updateReplyError = new GoogleApiError("rejected", "Request contains an invalid argument.", 400);
    const res = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toContain("Request contains an invalid argument.");
    const doc = await Review.findById(id);
    expect(doc!.publishing!.status).toBe("unpublished");
    expect(doc!.publishing!.error).toBe("Request contains an invalid argument.");
    expect(doc!.publishing!.attempts).toBe(1);

    // Retry succeeds and clears the error.
    fake.updateReplyError = null;
    const retry = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(retry.status).toBe(200);
    expect(retry.body.publishing.error).toBeUndefined();
  });

  it("a revoked grant is a 409 reconnect-required", async () => {
    const id = await syncedApprovedReview();
    fake.updateReplyError = new GoogleApiError("reconnect", "invalid_grant", 400);
    const res = await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/reconnect/);
  });

  it("mark-posted stays manual and never calls Google, even for a linked review", async () => {
    const id = await syncedApprovedReview();
    const res = await request(app).post(`/admin/api/reviews/${id}/mark-posted`).set(adminHeaders()).send({});
    expect(res.status).toBe(200);
    expect(res.body.publishing).toMatchObject({ status: "posted", method: "manual" });
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("approved queues include googleLinked (global + per-project)", async () => {
    const linkedId = await syncedApprovedReview();
    const manualId = await manualApprovedReview();
    for (const path of ["/admin/api/replies/approved", `/admin/api/projects/${projectId}/replies/approved`]) {
      const res = await request(app).get(path).set(adminHeaders());
      const byId = new Map(res.body.map((r: { id: string }) => [r.id, r]));
      expect((byId.get(linkedId) as { googleLinked: boolean }).googleLinked).toBe(true);
      expect((byId.get(manualId) as { googleLinked: boolean }).googleLinked).toBe(false);
      expect((byId.get(linkedId) as { projectName: string }).projectName).toBe("Alpha Co");
    }
    // Unlinking the project flips googleLinked off for its synced reviews.
    await request(app).delete(`/admin/api/projects/${projectId}/google`).set(adminHeaders()).expect(200);
    const after = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(after.body.find((r: { id: string }) => r.id === linkedId).googleLinked).toBe(false);
  });
});

describe("reply byte limit on existing endpoints", () => {
  it("client reply edit rejects > 4096 bytes; approve rejects an over-long stored reply", async () => {
    const id = await syncedApprovedReview();
    const edit = await request(app)
      .put(`/v1/reviews/${id}/reply`)
      .set({ Authorization: `Bearer ${apiKey}` })
      .send({ body: "😀".repeat(1100) }); // 1100 chars (2200 UTF-16), 4400 bytes
    expect(edit.status).toBe(400);

    await Review.updateOne({ _id: id }, { $set: { "reply.body": "é".repeat(2100), "approval.status": "awaiting_client" } });
    const approve = await request(app).post(`/v1/reviews/${id}/reply/approve`).set({ Authorization: `Bearer ${apiKey}` });
    expect(approve.status).toBe(400);
    expect(approve.body.error).toMatch(/4096 bytes/);
  });
});

describe("authorization boundaries", () => {
  const operatorRoutes = (reviewId: string, pid: string): [string, string][] => [
    ["get", "/admin/api/google/status"],
    ["post", "/admin/api/google/connect"],
    ["post", "/admin/api/google/disconnect"],
    ["get", "/admin/api/google/locations"],
    ["put", `/admin/api/projects/${pid}/google`],
    ["delete", `/admin/api/projects/${pid}/google`],
    ["post", `/admin/api/projects/${pid}/google/sync`],
    ["get", `/admin/api/projects/${pid}/google/sync`],
    ["post", `/admin/api/reviews/${reviewId}/publish`],
  ];

  it("operator Google endpoints require the admin token (401)", async () => {
    const id = await syncedApprovedReview();
    for (const [method, path] of operatorRoutes(id, projectId)) {
      const none = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path).send({});
      expect(none.status, `${method} ${path}`).toBe(401);
      const wrong = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path)
        .set("X-Admin-Token", "nope")
        .send({});
      expect(wrong.status, `${method} ${path}`).toBe(401);
    }
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("a client API key cannot reach any Google or publish route", async () => {
    const id = await syncedApprovedReview();
    for (const [method, path] of operatorRoutes(id, projectId)) {
      const res = await (request(app) as unknown as Record<string, (p: string) => request.Test>)[method](path)
        .set({ Authorization: `Bearer ${apiKey}` })
        .send({});
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    // No Google surface exists under /v1/reviews either.
    const clientPublish = await request(app).post(`/v1/reviews/${id}/publish`).set({ Authorization: `Bearer ${apiKey}` });
    expect(clientPublish.status).toBe(404);
    expect(fake.updateReplyCalls).toHaveLength(0);
  });

  it("the client review response exposes no google/publishing/sync fields", async () => {
    const id = await syncedApprovedReview();
    await request(app).post(`/admin/api/reviews/${id}/publish`).set(adminHeaders()).send({}).expect(200);

    const one = await request(app).get(`/v1/reviews/${id}`).set({ Authorization: `Bearer ${apiKey}` });
    expect(one.status).toBe(200);
    const list = await request(app).get("/v1/reviews").set({ Authorization: `Bearer ${apiKey}` });
    for (const body of [one.body, list.body[0]]) {
      expect(Object.keys(body).sort()).toEqual(
        ["analysis", "approval", "author", "createdAt", "id", "language", "rating", "reply", "reviewedAt", "text", "updatedAt"]
          .filter((k) => k in body)
          .sort(),
      );
      for (const key of ["google", "publishing", "source", "externalReviewId", "dedupeHash", "replyHistory", "projectId"]) {
        expect(body).not.toHaveProperty(key);
      }
      const text = JSON.stringify(body);
      for (const needle of ["reviewName", "replyUpdateTime", "google_api", "syncLocked", "lastSync", "accounts/"]) {
        expect(text).not.toContain(needle);
      }
      expect(Object.keys(body.reply).sort()).toEqual(["body", "editedAt", "generatedAt", "status"].filter((k) => k in body.reply).sort());
      expect(Object.keys(body.approval).sort()).toEqual(["approvedAt", "status"].filter((k) => k in body.approval).sort());
    }
  });
});
