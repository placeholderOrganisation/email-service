import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../app.js";
import { Project } from "../models/Project.js";
import { Review } from "../models/Review.js";
import { generateApiKey } from "../utils/apiKey.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../test/mongo.js";

const app = createApp();
const adminHeaders = () => ({ "X-Admin-Token": "test-admin-token" });

let projectAId: string;
let projectBId: string;
let keyA: string;
let keyB: string;

const authA = () => ({ Authorization: `Bearer ${keyA}` });
const authB = () => ({ Authorization: `Bearer ${keyB}` });

const sampleReview = {
  author: { name: "Alice" },
  rating: 5,
  text: "Great service, the staff were friendly and quick",
};
const negativeReview = {
  author: { name: "Bob" },
  rating: 1,
  text: "Terrible wait time and the place was dirty",
};

// Review-only projects intentionally have no fromAddress (proves it's optional).
async function makeProject(name: string): Promise<{ id: string; key: string }> {
  const key = generateApiKey();
  const project = await Project.create({
    name,
    apiKeyHash: key.hash,
    apiKeyLast4: key.last4,
    replyGuidelines: "Warm, concise, and professional.",
  });
  return { id: project._id.toString(), key: key.plaintext };
}

function importReview(projectId: string, body: object) {
  return request(app).post(`/admin/api/projects/${projectId}/reviews`).set(adminHeaders()).send(body);
}

/** Import one review and return its id. */
async function seedReview(projectId: string, body: object = sampleReview): Promise<string> {
  const res = await importReview(projectId, body);
  return res.body.created[0].id as string;
}

beforeAll(async () => {
  await connectMemoryMongo();
});
afterAll(async () => {
  await disconnectMemoryMongo();
});

beforeEach(async () => {
  await clearDatabase();
  const a = await makeProject("Alpha Co");
  const b = await makeProject("Bravo Co");
  projectAId = a.id;
  keyA = a.key;
  projectBId = b.id;
  keyB = b.key;
});

describe("operator import + AI pipeline", () => {
  it("imports a single review and runs analysis + reply synchronously (mock)", async () => {
    const res = await importReview(projectAId, sampleReview);
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.duplicates).toHaveLength(0);

    const doc = res.body.created[0];
    expect(doc.analysis.status).toBe("ready");
    expect(doc.analysis.sentiment).toBe("positive");
    expect(doc.reply.status).toBe("draft");
    expect(doc.reply.body.length).toBeGreaterThan(0);
    expect(doc.reply.source).toBe("ai");
    expect(doc.reply.model).toBe("mock");
  });

  it("supports bulk import via { reviews: [...] }", async () => {
    const res = await importReview(projectAId, { reviews: [sampleReview, negativeReview] });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(2);
    const sentiments = res.body.created.map((r: { analysis: { sentiment: string } }) => r.analysis.sentiment);
    expect(sentiments).toContain("positive");
    expect(sentiments).toContain("negative");
    const bodies = res.body.created.map((r: { reply: { body: string } }) => r.reply.body);
    expect(bodies[0]).not.toBe(bodies[1]);
  });

  it("dedupes: importing the same review twice creates only one doc", async () => {
    const first = await importReview(projectAId, sampleReview);
    expect(first.body.created).toHaveLength(1);

    const second = await importReview(projectAId, sampleReview);
    expect(second.body.created).toHaveLength(0);
    expect(second.body.duplicates).toHaveLength(1);
    expect(second.body.duplicates[0].id).toBe(first.body.created[0].id);

    expect(await Review.countDocuments({ projectId: projectAId })).toBe(1);
  });
});

describe("rating-only reviews (no text)", () => {
  it("imports a rating-only review and still analyzes + drafts a reply", async () => {
    const res = await importReview(projectAId, {
      author: { name: "Cara" },
      rating: 5,
      source: "google",
      externalReviewId: "g-rateonly-1",
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);

    const doc = res.body.created[0];
    expect(doc.text).toBe("");
    expect(doc.analysis.status).toBe("ready");
    expect(doc.analysis.sentiment).toBe("positive"); // derived from the 5-star rating
    expect(doc.reply.status).toBe("draft");
    expect(doc.reply.body.length).toBeGreaterThan(0);
  });

  it("does not falsely dedupe two distinct rating-only Google reviews with the same author+rating", async () => {
    const base = { author: { name: "Same Name" }, rating: 5, source: "google" as const };
    const first = await importReview(projectAId, { ...base, externalReviewId: "g-1" });
    const second = await importReview(projectAId, { ...base, externalReviewId: "g-2" });
    expect(first.body.created).toHaveLength(1);
    expect(second.body.created).toHaveLength(1);
    expect(second.body.duplicates).toHaveLength(0);
    expect(await Review.countDocuments({ projectId: projectAId })).toBe(2);

    // Re-importing the same external id is still idempotent.
    const dup = await importReview(projectAId, { ...base, externalReviewId: "g-1" });
    expect(dup.body.created).toHaveLength(0);
    expect(dup.body.duplicates).toHaveLength(1);
  });
});

describe("operator import with an existing owner response", () => {
  const ownerResponseText = "Thank you so much for the kind words, Alice — see you again soon!";

  it("preserves the owner response as an imported, already-posted reply (analysis still runs)", async () => {
    const res = await importReview(projectAId, {
      ...sampleReview,
      ownerResponse: { text: ownerResponseText, postedAt: "2025-01-15T10:00:00.000Z" },
    });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);

    const doc = res.body.created[0];
    // Analysis is useful, so it still runs.
    expect(doc.analysis.status).toBe("ready");
    expect(doc.analysis.sentiment).toBe("positive");
    // The reply is the preserved owner response — never AI-generated.
    expect(doc.reply.body).toBe(ownerResponseText);
    expect(doc.reply.source).toBe("imported");
    expect(doc.reply.status).toBe("draft");
    // Auto-approved and already posted.
    expect(doc.approval.status).toBe("approved");
    expect(doc.approval.approvedBy).toBe("operator");
    expect(doc.publishing.status).toBe("posted");
    expect(doc.publishing.method).toBe("manual");
    expect(new Date(doc.publishing.postedAt).toISOString()).toBe("2025-01-15T10:00:00.000Z");
  });

  it("keeps an imported owner response OUT of the approved (to-post) queue", async () => {
    const res = await importReview(projectAId, {
      ...sampleReview,
      ownerResponse: { text: ownerResponseText },
    });
    const importedId = res.body.created[0].id as string;

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(queue.status).toBe(200);
    expect(queue.body.find((r: { id: string }) => r.id === importedId)).toBeUndefined();
  });

  it("still dedupes an imported owner response on re-import", async () => {
    const first = await importReview(projectAId, { ...sampleReview, ownerResponse: { text: ownerResponseText } });
    expect(first.body.created).toHaveLength(1);
    const second = await importReview(projectAId, { ...sampleReview, ownerResponse: { text: ownerResponseText } });
    expect(second.body.created).toHaveLength(0);
    expect(second.body.duplicates).toHaveLength(1);
    expect(await Review.countDocuments({ projectId: projectAId })).toBe(1);
  });

  it("without an owner response, the generated draft reaches the approved queue after approval", async () => {
    const id = await seedReview(projectAId);
    const before = await request(app).get(`/admin/api/reviews/${id}`).set(adminHeaders());
    expect(before.body.reply.source).toBe("ai");
    expect(before.body.publishing.status).toBe("unpublished");

    await request(app).post(`/admin/api/reviews/${id}/reply/approve`).set(adminHeaders()).expect(200);

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(queue.body.find((r: { id: string }) => r.id === id)).toBeTruthy();
  });

  it("cross-project approved queue includes the project (client) name per row", async () => {
    const id = await seedReview(projectAId);
    await request(app).post(`/admin/api/reviews/${id}/reply/approve`).set(adminHeaders()).expect(200);

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    const row = queue.body.find((r: { id: string }) => r.id === id);
    expect(row).toBeTruthy();
    expect(row.projectName).toBe("Alpha Co");
  });
});

describe("client read surface", () => {
  it("lists this project's reviews and fetches one", async () => {
    const id = await seedReview(projectAId);

    const list = await request(app).get("/v1/reviews").set(authA());
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    expect(list.body[0].id).toBe(id);

    const one = await request(app).get(`/v1/reviews/${id}`).set(authA());
    expect(one.status).toBe(200);
    expect(one.body.rating).toBe(5);
    expect(one.body.reply.body.length).toBeGreaterThan(0); // draft present on import
    expect(one.body.reply.status).toBe("draft");
  });

  it("isolates tenants: client A cannot read client B's review (404, not 403)", async () => {
    const idB = await seedReview(projectBId);

    const res = await request(app).get(`/v1/reviews/${idB}`).set(authA());
    expect(res.status).toBe(404);

    // And A's listing never includes B's review.
    const list = await request(app).get("/v1/reviews").set(authA());
    expect(list.body).toHaveLength(0);
  });

  it("redacts all internal fields from the client projection", async () => {
    const id = await seedReview(projectAId);
    const res = await request(app).get(`/v1/reviews/${id}`).set(authA());
    expect(res.status).toBe(200);

    for (const key of ["publishing", "source", "externalReviewId", "dedupeHash", "replyHistory", "projectId"]) {
      expect(res.body).not.toHaveProperty(key);
    }
    // Analysis/reply are present but stripped of operational fields.
    expect(res.body.analysis).not.toHaveProperty("error");
    expect(res.body.analysis).not.toHaveProperty("attempts");
    expect(res.body.reply).not.toHaveProperty("error");
    expect(res.body.reply).not.toHaveProperty("attempts");
    expect(res.body.reply).not.toHaveProperty("source");
  });
});

describe("client reply lifecycle", () => {
  it("edits the reply without approving it and marks it edited", async () => {
    const id = await seedReview(projectAId);

    const res = await request(app)
      .put(`/v1/reviews/${id}/reply`)
      .set(authA())
      .send({ body: "Thanks so much Alice, we appreciate you!" });
    expect(res.status).toBe(200);
    expect(res.body.reply.body).toBe("Thanks so much Alice, we appreciate you!");
    expect(res.body.approval.status).toBe("awaiting_client"); // editing never approves

    const doc = await Review.findById(id);
    expect(doc!.reply!.source).toBe("edited");
    expect(doc!.reply!.editedBy).toBe("client");
  });

  it("regenerates the reply, keeps approval awaiting, and grows replyHistory", async () => {
    const id = await seedReview(projectAId);
    const before = await Review.findById(id);
    const beforeHistory = before!.replyHistory!.length;

    const res = await request(app).post(`/v1/reviews/${id}/reply/regenerate`).set(authA());
    expect(res.status).toBe(200);
    expect(res.body.reply.status).toBe("draft");
    expect(res.body.reply.body.length).toBeGreaterThan(0);
    expect(res.body.approval.status).toBe("awaiting_client");

    const after = await Review.findById(id);
    expect(after!.replyHistory!.length).toBe(beforeHistory + 1);
  });

  it("approves the reply, and an edited-but-unapproved review stays awaiting", async () => {
    // Approve one review.
    const approvedId = await seedReview(projectAId);
    const approve = await request(app).post(`/v1/reviews/${approvedId}/reply/approve`).set(authA());
    expect(approve.status).toBe(200);
    expect(approve.body.approval.status).toBe("approved");
    expect(approve.body.approval.approvedAt).toBeTruthy();

    // A different review that is edited but never approved.
    const editedId = await seedReview(projectAId, negativeReview);
    await request(app).put(`/v1/reviews/${editedId}/reply`).set(authA()).send({ body: "We are sorry, Bob." });
    const editedGet = await request(app).get(`/v1/reviews/${editedId}`).set(authA());
    expect(editedGet.body.approval.status).toBe("awaiting_client");
  });

  it("resets approval when an already-approved reply is edited", async () => {
    const id = await seedReview(projectAId);
    await request(app).post(`/v1/reviews/${id}/reply/approve`).set(authA()).expect(200);

    const edit = await request(app).put(`/v1/reviews/${id}/reply`).set(authA()).send({ body: "Updated reply text." });
    expect(edit.status).toBe(200);
    expect(edit.body.approval.status).toBe("awaiting_client");
  });
});

describe("operator approved-replies queue + publishing", () => {
  it("queues approved+unpublished replies and excludes unapproved ones", async () => {
    const approvedId = await seedReview(projectAId);
    await request(app).post(`/v1/reviews/${approvedId}/reply/approve`).set(authA()).expect(200);
    // A second, unapproved review must NOT appear in the queue.
    await seedReview(projectBId, negativeReview);

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(queue.status).toBe(200);
    expect(queue.body).toHaveLength(1);
    expect(queue.body[0].id).toBe(approvedId);
  });

  it("marks an approved reply posted and removes it from the queue", async () => {
    const id = await seedReview(projectAId);
    await request(app).post(`/v1/reviews/${id}/reply/approve`).set(authA()).expect(200);

    const posted = await request(app)
      .post(`/admin/api/reviews/${id}/mark-posted`)
      .set(adminHeaders())
      .send({ note: "Posted on Google by hand" });
    expect(posted.status).toBe(200);
    expect(posted.body.publishing.status).toBe("posted");
    expect(posted.body.publishing.method).toBe("manual");
    expect(posted.body.publishing.note).toBe("Posted on Google by hand");

    const queue = await request(app).get("/admin/api/replies/approved").set(adminHeaders());
    expect(queue.body.find((r: { id: string }) => r.id === id)).toBeUndefined();
  });

  it("rejects mark-posted before approval", async () => {
    const id = await seedReview(projectAId);
    const res = await request(app).post(`/admin/api/reviews/${id}/mark-posted`).set(adminHeaders()).send({});
    expect(res.status).toBe(400);
  });
});

describe("authorization", () => {
  it("rejects client review access without an API key", async () => {
    const res = await request(app).get("/v1/reviews");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid client API key", async () => {
    const res = await request(app).get("/v1/reviews").set({ Authorization: "Bearer esk_nope" });
    expect(res.status).toBe(401);
  });

  it("rejects operator review routes without / with a wrong admin token", async () => {
    const noToken = await request(app).get(`/admin/api/projects/${projectAId}/reviews`);
    expect(noToken.status).toBe(401);

    const wrong = await request(app)
      .get(`/admin/api/projects/${projectAId}/reviews`)
      .set("X-Admin-Token", "nope");
    expect(wrong.status).toBe(401);
  });

  it("cross-project client mutation is a 404, never touching the other tenant", async () => {
    const idB = await seedReview(projectBId);
    const res = await request(app)
      .put(`/v1/reviews/${idB}/reply`)
      .set(authA())
      .send({ body: "malicious edit" });
    expect(res.status).toBe(404);

    const doc = await Review.findById(idB);
    expect(doc!.reply!.body).not.toBe("malicious edit");
  });
});
