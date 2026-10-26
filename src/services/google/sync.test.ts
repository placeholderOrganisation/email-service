import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Types } from "mongoose";
import { Project } from "../../models/Project.js";
import { Review } from "../../models/Review.js";
import { generateApiKey } from "../../utils/apiKey.js";
import { computeDedupeHash } from "../../utils/reviewDedupe.js";
import { clearDatabase, connectMemoryMongo, disconnectMemoryMongo } from "../../test/mongo.js";
import { ACCOUNT, LOCATION, apiReview, createFakeGoogle, type FakeGoogle } from "../../test/fakeGoogle.js";
import { approveReply, importReview, processReview } from "../reviewPipeline.js";
import { GoogleApiError, setGoogleClientForTests } from "./client.js";
import { storeGoogleConnection } from "./connection.js";
import { acquireSyncLock, syncAllProjects, syncProject } from "./sync.js";

let fake: FakeGoogle;
let projectId: Types.ObjectId;

async function makeProject(name: string, google?: Record<string, unknown>) {
  const key = generateApiKey();
  const project = await Project.create({ name, apiKeyHash: key.hash, apiKeyLast4: key.last4, google });
  return project._id;
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
  await storeGoogleConnection({ refreshToken: "rt", scopes: [] });
  projectId = await makeProject("Alpha Co", {
    accountName: ACCOUNT,
    locationName: LOCATION,
    locationTitle: "Alpha Co Downtown",
    syncEnabled: true,
  });
});

describe("syncProject: new reviews", () => {
  it("creates reviews, runs AI, and sets google.* + externalReviewId", async () => {
    fake.reviews = [
      apiReview("r1", { createTime: "2025-01-02T03:04:05.000Z" }),
      apiReview("r2", { reviewer: { isAnonymous: true }, starRating: "ONE", comment: "Rude staff" }),
      apiReview("r3", { starRating: "STAR_RATING_UNSPECIFIED" }),
    ];
    const result = await syncProject(projectId);
    expect(result.status).toBe("ok");
    expect(result.stats).toEqual({ fetched: 3, created: 2, updated: 0, linked: 0, skipped: 1 });

    const r1 = await Review.findOne({ projectId, "google.reviewName": `${ACCOUNT}/${LOCATION}/reviews/r1` });
    expect(r1).toBeTruthy();
    expect(r1!.externalReviewId).toBe("r1");
    expect(r1!.source).toBe("google");
    expect(r1!.reviewedAt!.toISOString()).toBe("2025-01-02T03:04:05.000Z");
    expect(r1!.google!.updateTime!.toISOString()).toBe("2025-03-01T12:00:00.000Z");
    expect(r1!.analysis!.status).toBe("ready");
    expect(r1!.reply!.status).toBe("draft");
    expect(r1!.reply!.source).toBe("ai");
    // Hash matches importReview's hashing for API ids.
    expect(r1!.dedupeHash).toBe(computeDedupeHash(projectId, r1!.author!, 5, r1!.text, "r1"));

    const r2 = await Review.findOne({ projectId, externalReviewId: "r2" });
    expect(r2!.author!.name).toBe("Anonymous");
    expect(r2!.analysis!.sentiment).toBe("negative");

    const project = await Project.findById(projectId);
    expect(project!.google!.lastSyncStatus).toBe("ok");
    expect(project!.google!.lastSyncedAt).toBeTruthy();
    expect(project!.google!.syncLockedAt).toBeNull();
    expect(project!.google!.lastSyncStats!.created).toBe(2);
  });

  it("records a review that was already replied to on Google as imported + posted", async () => {
    fake.reviews = [apiReview("r1", { reviewReply: { comment: "Thanks!", updateTime: "2025-03-05T00:00:00.000Z" } })];
    await syncProject(projectId);
    const doc = await Review.findOne({ projectId });
    expect(doc!.reply!.source).toBe("imported");
    expect(doc!.reply!.body).toBe("Thanks!");
    expect(doc!.publishing!.status).toBe("posted");
    expect(doc!.google!.replyUpdateTime!.toISOString()).toBe("2025-03-05T00:00:00.000Z");
  });

  it("re-sync is idempotent: no duplicates and unchanged reviews are untouched", async () => {
    fake.reviews = [apiReview("r1"), apiReview("r2", { comment: "Fine" })];
    await syncProject(projectId);
    const before = await Review.find({ projectId }).sort({ _id: 1 }).lean();

    const second = await syncProject(projectId);
    expect(second.stats).toMatchObject({ fetched: 2, created: 0, updated: 0, linked: 0 });
    const after = await Review.find({ projectId }).sort({ _id: 1 }).lean();
    expect(after).toHaveLength(2);
    expect(after.map((d) => d.updatedAt!.getTime())).toEqual(before.map((d) => d.updatedAt!.getTime()));
  });

  it("one review's failure does not abort the sync", async () => {
    // A malformed createTime makes this review fail the Date cast on insert.
    fake.reviews = [apiReview("bad", { createTime: "not-a-date", updateTime: "2025-03-02T00:00:00.000Z" }), apiReview("ok")];
    const result = await syncProject(projectId);
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/1 review\(s\) failed/);
    expect(await Review.countDocuments({ projectId, externalReviewId: "ok" })).toBe(1);
    const project = await Project.findById(projectId);
    expect(project!.google!.lastSyncedAt).toBeFalsy(); // cursor not advanced on error
    expect(project!.google!.syncLockedAt).toBeNull();
  });
});

describe("syncProject: reconciliation with HTML/manual imports", () => {
  it("links an HTML-style import (Maps id) instead of duplicating it", async () => {
    const { review: html } = await importReview(projectId, {
      author: { name: "alice   EXAMPLE" },
      rating: 5,
      text: "Great  service from review r1",
      source: "google",
      externalReviewId: "ChZDSUhNMG9nS0VJQ0FnSURtYXBzaWQ", // Maps data-review-id
      reviewedAt: new Date("2025-01-01T00:00:00.000Z"), // approximate ("3 months ago")
    });
    await processReview(html);
    const analyzedAt = html.analysis!.generatedAt!.getTime();

    fake.reviews = [apiReview("r1", { createTime: "2025-02-14T08:00:00.000Z" })];
    const result = await syncProject(projectId);
    expect(result.stats).toMatchObject({ created: 0, linked: 1 });

    expect(await Review.countDocuments({ projectId })).toBe(1);
    const doc = await Review.findById(html._id);
    expect(doc!.google!.reviewName).toBe(`${ACCOUNT}/${LOCATION}/reviews/r1`);
    expect(doc!.externalReviewId).toBe("r1");
    expect(doc!.reviewedAt!.toISOString()).toBe("2025-02-14T08:00:00.000Z");
    expect(doc!.source).toBe("google");
    expect(doc!.dedupeHash).toBe(computeDedupeHash(projectId, doc!.author!, 5, doc!.text, "r1"));
    expect(doc!.analysis!.generatedAt!.getTime()).toBe(analyzedAt); // AI not re-run

    // And a re-sync leaves it alone.
    const again = await syncProject(projectId);
    expect(again.stats).toMatchObject({ created: 0, linked: 0, updated: 0 });
  });

  it("links a rating-only import only when author+rating is unambiguous", async () => {
    await importReview(projectId, { author: { name: "Bob" }, rating: 5, text: "", externalReviewId: "maps-1" });
    fake.reviews = [apiReview("solo", { reviewer: { displayName: "Bob" }, comment: undefined })];
    const result = await syncProject(projectId);
    expect(result.stats).toMatchObject({ linked: 1, created: 0 });
  });

  it("creates new (does not guess) when a rating-only author+rating pair is ambiguous", async () => {
    await importReview(projectId, { author: { name: "Bob" }, rating: 5, text: "", externalReviewId: "maps-1" });
    await importReview(projectId, { author: { name: "Bob" }, rating: 5, text: "", externalReviewId: "maps-2" });
    fake.reviews = [apiReview("solo", { reviewer: { displayName: "Bob" }, comment: undefined })];
    const result = await syncProject(projectId);
    expect(result.stats).toMatchObject({ linked: 0, created: 1 });
    expect(await Review.countDocuments({ projectId })).toBe(3);
  });
});

describe("syncProject: updates from Google", () => {
  it("an edited review updates content and resets an approved-unposted reply to awaiting_client", async () => {
    fake.reviews = [apiReview("r1")];
    await syncProject(projectId);
    const doc = await Review.findOne({ projectId });
    await approveReply(doc!, { by: "client" });
    const approvedBody = doc!.reply!.body;

    fake.reviews = [apiReview("r1", { comment: "Actually it was slow", starRating: "TWO", updateTime: "2025-04-01T00:00:00.000Z" })];
    const result = await syncProject(projectId);
    expect(result.stats.updated).toBe(1);

    const after = await Review.findById(doc!._id);
    expect(after!.text).toBe("Actually it was slow");
    expect(after!.rating).toBe(2);
    expect(after!.approval!.status).toBe("awaiting_client");
    expect(after!.reply!.body).toBe(approvedBody); // reply kept for the client to re-check
    expect(after!.replyHistory!.map((h) => h.reason)).toContain("review-edited");
    expect(after!.analysis!.sentiment).toBe("negative"); // re-analyzed
    expect(after!.google!.updateTime!.toISOString()).toBe("2025-04-01T00:00:00.000Z");
  });

  it("an edited review regenerates an unapproved AI draft", async () => {
    fake.reviews = [apiReview("r1")];
    await syncProject(projectId);
    fake.reviews = [apiReview("r1", { comment: "Changed my mind, terrible", starRating: "ONE", updateTime: "2025-04-01T00:00:00.000Z" })];
    await syncProject(projectId);
    const after = await Review.findOne({ projectId });
    expect(after!.reply!.source).toBe("ai");
    expect(after!.reply!.status).toBe("draft");
    expect(after!.replyHistory!.map((h) => h.reason)).toContain("regenerate");
    expect(after!.approval!.status).toBe("awaiting_client");
  });

  it("a Google-side reply on an unposted review marks it posted/imported", async () => {
    fake.reviews = [apiReview("r1")];
    await syncProject(projectId);
    const aiBody = (await Review.findOne({ projectId }))!.reply!.body;

    fake.reviews = [
      apiReview("r1", {
        updateTime: "2025-03-10T00:00:00.000Z",
        reviewReply: { comment: "Owner replied directly", updateTime: "2025-03-10T00:00:00.000Z" },
      }),
    ];
    const result = await syncProject(projectId);
    expect(result.stats.updated).toBe(1);

    const doc = await Review.findOne({ projectId });
    expect(doc!.reply!.body).toBe("Owner replied directly");
    expect(doc!.reply!.source).toBe("imported");
    expect(doc!.approval!.status).toBe("approved");
    expect(doc!.approval!.approvedBy).toBe("operator");
    expect(doc!.publishing!.status).toBe("posted");
    expect(doc!.publishing!.method).toBe("manual");
    expect(doc!.publishing!.note).toBe("Replied on Google outside the service");
    expect(doc!.publishing!.postedAt!.toISOString()).toBe("2025-03-10T00:00:00.000Z");
    const archived = doc!.replyHistory!.find((h) => h.reason === "replied-on-google");
    expect(archived!.body).toBe(aiBody);
  });

  it("a Google-side reply on an already-posted review only records replyUpdateTime", async () => {
    fake.reviews = [apiReview("r1")];
    await syncProject(projectId);
    const doc = await Review.findOne({ projectId });
    doc!.set({ "approval.status": "approved", "publishing.status": "posted", "publishing.method": "google_api" });
    await doc!.save();
    const body = doc!.reply!.body;

    fake.reviews = [apiReview("r1", { reviewReply: { comment: body!, updateTime: "2025-05-05T00:00:00.000Z" } })];
    await syncProject(projectId);
    const after = await Review.findById(doc!._id);
    expect(after!.google!.replyUpdateTime!.toISOString()).toBe("2025-05-05T00:00:00.000Z");
    expect(after!.publishing!.method).toBe("google_api");
    expect(after!.replyHistory).toHaveLength(0);
  });
});

describe("syncProject: paging + locking", () => {
  it("first sync pages everything; later syncs stop once a page predates lastSyncedAt - 1 day", async () => {
    fake.pageSize = 2;
    fake.reviews = Array.from({ length: 6 }, (_, i) =>
      apiReview(`r${i}`, { updateTime: new Date(Date.UTC(2024, 0, 1 + i)).toISOString(), comment: `Review ${i}` }),
    );
    await syncProject(projectId);
    expect(fake.listReviewsCalls).toHaveLength(3);
    expect(await Review.countDocuments({ projectId })).toBe(6);

    fake.listReviewsCalls = [];
    await syncProject(projectId);
    expect(fake.listReviewsCalls).toHaveLength(1);
  });

  it("the sync lock prevents concurrent runs and is always released", async () => {
    let release!: () => void;
    fake.listReviewsGate = new Promise((r) => (release = r));
    fake.reviews = [apiReview("r1")];

    const first = syncProject(projectId);
    // Wait until the first run is holding the lock.
    while (fake.listReviewsCalls.length === 0) await new Promise((r) => setTimeout(r, 5));
    const second = await syncProject(projectId);
    expect(second.status).toBe("locked");
    expect((await Project.findById(projectId))!.google!.lastSyncStatus).toBe("running");

    release();
    expect((await first).status).toBe("ok");
    expect((await Project.findById(projectId))!.google!.syncLockedAt).toBeNull();
    expect(await Review.countDocuments({ projectId })).toBe(1);
  });

  it("reclaims a stale (crashed) lock", async () => {
    await Project.updateOne({ _id: projectId }, { $set: { "google.syncLockedAt": new Date(Date.now() - 20 * 60_000) } });
    expect((await syncProject(projectId)).status).toBe("ok");
  });

  it("a Google failure ends in error status, releases the lock, and keeps the cursor", async () => {
    fake.listReviewsError = new GoogleApiError("transient", "Backend Error", 503);
    const result = await syncProject(projectId);
    expect(result.status).toBe("error");
    const project = await Project.findById(projectId);
    expect(project!.google!.lastSyncStatus).toBe("error");
    expect(project!.google!.lastSyncError).toBe("Backend Error");
    expect(project!.google!.syncLockedAt).toBeNull();
    expect(project!.google!.lastSyncedAt).toBeFalsy();
  });

  it("refuses unlinked projects", async () => {
    const other = await makeProject("Unlinked");
    expect((await acquireSyncLock(other)).ok).toBe(false);
    expect((await syncProject(other)).status).toBe("not_linked");
  });
});

describe("syncAllProjects", () => {
  it("syncs only sync-enabled linked projects", async () => {
    await makeProject("Disabled", { accountName: ACCOUNT, locationName: "locations/333", syncEnabled: false });
    fake.reviews = [apiReview("r1")];
    const { skipped, results } = await syncAllProjects();
    expect(skipped).toBe(false);
    expect(results.map((r) => r.projectId)).toEqual([String(projectId)]);
  });

  it("skips everything when Google is not connected", async () => {
    const { GoogleConnection } = await import("../../models/GoogleConnection.js");
    await GoogleConnection.deleteMany({});
    const out = await syncAllProjects();
    expect(out).toEqual({ skipped: true, results: [] });
    expect(fake.listReviewsCalls).toHaveLength(0);
  });
});
