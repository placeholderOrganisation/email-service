// Pulls Business Profile reviews into the existing review pipeline. Runs from
// the scheduled worker (worker/reviewSyncWorker.ts) and the operator's
// "Sync now". Background work: AI runs sequentially, inline, per new review.

import type { Types } from "mongoose";
import { env, isGoogleConfigured } from "../../config/env.js";
import { Project, type ProjectDocument } from "../../models/Project.js";
import { Review, type ReviewDocument } from "../../models/Review.js";
import { authorRatingKey, computeContentFingerprint, computeDedupeHash } from "../../utils/reviewDedupe.js";
import {
  archivePriorReply,
  importReview,
  processReview,
  reanalyzeReview,
  regenerateReply,
  resetApproval,
  withSubdocs,
} from "../reviewPipeline.js";
import { GoogleApiError, getGoogleClient, type GoogleReview } from "./client.js";
import { isGoogleConnected } from "./connection.js";
import { mapGoogleReview, type MappedGoogleReview } from "./mapReview.js";

export const SYNC_LOCK_STALE_MS = 15 * 60_000;
// Re-scan reviews updated up to a day before the last successful sync, so edits
// that land around a sync boundary (or clock skew) are never missed.
const OVERLAP_MS = 24 * 60 * 60_000;
const MAX_REVIEW_PAGES = 400; // 50/page → 20k reviews; a runaway-pagination guard

export interface SyncStats {
  fetched: number;
  created: number;
  updated: number;
  linked: number;
  skipped: number;
}

export interface SyncResult {
  status: "ok" | "error" | "locked" | "not_linked" | "not_found";
  stats: SyncStats;
  error?: string;
  reconnectRequired?: boolean;
}

export interface SyncOptions {
  /** Checked between reviews/pages; returning true aborts the sync (graceful shutdown). */
  shouldStop?: () => boolean;
}

const emptyStats = (): SyncStats => ({ fetched: 0, created: 0, updated: 0, linked: 0, skipped: 0 });

function syncLog(level: "log" | "warn", message: string, extra: Record<string, unknown> = {}): void {
  if (env.nodeEnv === "test") return;
  const fields = Object.entries(extra)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  console[level](`[review-sync] ${message}${fields ? ` ${fields}` : ""}`);
}

const errMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err)).slice(0, 1000);

// ---- lock ----

type LockResult =
  | { ok: true; project: ProjectDocument; lockedAt: Date }
  | { ok: false; reason: "not_found" | "not_linked" | "locked" };

/**
 * Atomically claims the per-project sync lock (free, or older than 15 min =
 * orphaned by a crash) and flips status to "running".
 */
export async function acquireSyncLock(projectId: Types.ObjectId | string): Promise<LockResult> {
  const lockedAt = new Date();
  const staleBefore = new Date(lockedAt.getTime() - SYNC_LOCK_STALE_MS);
  const project = await Project.findOneAndUpdate(
    {
      _id: projectId,
      "google.accountName": { $type: "string" },
      "google.locationName": { $type: "string" },
      $or: [{ "google.syncLockedAt": null }, { "google.syncLockedAt": { $lte: staleBefore } }],
    },
    { $set: { "google.syncLockedAt": lockedAt, "google.lastSyncStatus": "running" } },
    { new: true },
  );
  if (project) return { ok: true, project, lockedAt };

  const existing = await Project.findById(projectId);
  if (!existing) return { ok: false, reason: "not_found" };
  if (!existing.google?.locationName || !existing.google?.accountName) return { ok: false, reason: "not_linked" };
  return { ok: false, reason: "locked" };
}

/** True while a non-stale lock is held. */
export function isSyncRunning(project: { google?: { syncLockedAt?: Date | null } | null }): boolean {
  const at = project.google?.syncLockedAt;
  return Boolean(at && at.getTime() > Date.now() - SYNC_LOCK_STALE_MS);
}

/** Runs a sync under an already-acquired lock, and ALWAYS releases it. */
export async function runLockedSync(
  project: ProjectDocument,
  lockedAt: Date,
  opts: SyncOptions = {},
): Promise<SyncResult> {
  const stats = emptyStats();
  let error: string | undefined;
  let reconnectRequired = false;
  syncLog("log", "started", { project: String(project._id) });
  try {
    error = await syncReviews(project, stats, opts);
  } catch (err) {
    error = errMessage(err);
    reconnectRequired = err instanceof GoogleApiError && err.reconnectRequired;
  } finally {
    await Project.updateOne(
      { _id: project._id, "google.syncLockedAt": lockedAt },
      {
        $set: {
          "google.syncLockedAt": null,
          "google.lastSyncStatus": error ? "error" : "ok",
          "google.lastSyncStats": stats,
          "google.lastSyncError": error ?? null,
          // Only a clean sync advances the incremental cursor (to its START time).
          ...(error ? {} : { "google.lastSyncedAt": lockedAt }),
        },
      },
    );
  }
  syncLog(error ? "warn" : "log", "finished", { project: String(project._id), ...stats, error });
  return { status: error ? "error" : "ok", stats, error, reconnectRequired };
}

/** Sync one project's reviews (lock → page → reconcile → release). */
export async function syncProject(projectId: Types.ObjectId | string, opts: SyncOptions = {}): Promise<SyncResult> {
  const lock = await acquireSyncLock(projectId);
  if (!lock.ok) return { status: lock.reason, stats: emptyStats() };
  return runLockedSync(lock.project, lock.lockedAt, opts);
}

/** Every sync-enabled, linked project, sequentially. No-op unless Google is configured + connected. */
export async function syncAllProjects(
  opts: SyncOptions = {},
): Promise<{ skipped: boolean; results: { projectId: string; result: SyncResult }[] }> {
  if (!isGoogleConfigured() || !(await isGoogleConnected())) return { skipped: true, results: [] };
  const projects = await Project.find({
    "google.syncEnabled": true,
    "google.accountName": { $type: "string" },
    "google.locationName": { $type: "string" },
  })
    .select("_id")
    .sort({ createdAt: 1 });

  const results: { projectId: string; result: SyncResult }[] = [];
  for (const p of projects) {
    if (opts.shouldStop?.()) break;
    const result = await syncProject(p._id, opts);
    results.push({ projectId: String(p._id), result });
    // A dead grant fails every project the same way — stop and let the operator reconnect.
    if (result.reconnectRequired) break;
  }
  return { skipped: false, results };
}

// ---- the sync itself ----

/** Pages reviews newest-updated first. Returns a summary error if some reviews failed (sync continues past them). */
async function syncReviews(project: ProjectDocument, stats: SyncStats, opts: SyncOptions): Promise<string | undefined> {
  const accountName = project.google!.accountName!;
  const locationName = project.google!.locationName!;
  const lastSyncedAt = project.google?.lastSyncedAt;
  const cutoff = lastSyncedAt ? new Date(lastSyncedAt.getTime() - OVERLAP_MS) : null;
  const pool = await loadReconcilePool(project._id);
  const client = getGoogleClient();
  const failures: string[] = [];

  let pageToken: string | undefined;
  for (let page = 0; page < MAX_REVIEW_PAGES; page++) {
    if (opts.shouldStop?.()) throw new Error("Sync interrupted by shutdown");
    const res = await client.listReviews(accountName, locationName, pageToken);
    for (const apiReview of res.reviews) {
      if (opts.shouldStop?.()) throw new Error("Sync interrupted by shutdown");
      stats.fetched += 1;
      try {
        await syncOne(project._id, apiReview, stats, pool);
      } catch (err) {
        failures.push(`${apiReview.name}: ${errMessage(err)}`);
      }
    }
    // Newest-first: once a whole page predates the cutoff, everything after does too.
    const pageIsOld =
      cutoff !== null &&
      res.reviews.length > 0 &&
      res.reviews.every((r) => new Date(r.updateTime).getTime() < cutoff.getTime());
    if (pageIsOld || !res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }

  if (!failures.length) return undefined;
  return `${failures.length} review(s) failed to sync; first: ${failures[0]}`.slice(0, 1000);
}

// ---- reconciliation with previously (manually/HTML) imported reviews ----

interface PoolEntry {
  id: string;
  fingerprint: string;
  authorRating: string;
  used: boolean;
}

/** Unlinked docs (no google.reviewName) in the project, fingerprinted by content. */
async function loadReconcilePool(projectId: Types.ObjectId): Promise<PoolEntry[]> {
  const docs = await Review.find({ projectId, "google.reviewName": { $not: { $type: "string" } } })
    .select("author rating text")
    .lean();
  return docs.map((d) => ({
    id: String(d._id),
    fingerprint: computeContentFingerprint(d.author, d.rating, d.text),
    authorRating: authorRatingKey(d.author, d.rating),
    used: false,
  }));
}

function takeContentMatch(pool: PoolEntry[], mapped: MappedGoogleReview): string | null {
  const { author, rating, text } = mapped.input;
  const fingerprint = computeContentFingerprint(author, rating, text);
  const match = pool.find((e) => !e.used && e.fingerprint === fingerprint);
  if (!match) return null;
  // Rating-only reviews carry almost no signal: only link when the author+rating
  // pair is unambiguous among the still-unlinked docs.
  if (!text) {
    const key = authorRatingKey(author, rating);
    if (pool.filter((e) => !e.used && e.authorRating === key).length !== 1) return null;
  }
  match.used = true;
  return match.id;
}

function markUsed(pool: PoolEntry[], id: string): void {
  const entry = pool.find((e) => e.id === id);
  if (entry) entry.used = true;
}

// ---- per-review ----

async function syncOne(
  projectId: Types.ObjectId,
  apiReview: GoogleReview,
  stats: SyncStats,
  pool: PoolEntry[],
): Promise<void> {
  const mapped = mapGoogleReview(apiReview);
  if (!mapped) {
    stats.skipped += 1;
    return;
  }

  // (a) Already synced → update if Google's copy changed.
  const synced = await Review.findOne({ projectId, "google.reviewName": mapped.google.reviewName });
  if (synced) {
    if (await applyGoogleUpdate(synced, mapped)) stats.updated += 1;
    return;
  }

  // (a') An unlinked doc already carrying this exact API reviewId (e.g. a JSON
  // import of API data). Exact id beats a content match, and linking another
  // doc would collide on the {projectId, externalReviewId} unique index.
  const sameId = await Review.findOne({
    projectId,
    externalReviewId: mapped.input.externalReviewId,
    "google.reviewName": { $not: { $type: "string" } },
  });
  if (sameId) {
    markUsed(pool, String(sameId._id));
    await linkExisting(sameId, mapped);
    stats.linked += 1;
    return;
  }

  // (b) Reconcile with a previous manual/HTML import of the same review.
  const matchId = takeContentMatch(pool, mapped);
  if (matchId) {
    const doc = await Review.findOne({ _id: matchId, "google.reviewName": { $not: { $type: "string" } } });
    if (doc) {
      await linkExisting(doc, mapped);
      stats.linked += 1;
      return;
    }
  }

  // (c) New review.
  const { review, created } = await importReview(projectId, mapped.input);
  if (!created) {
    // importReview found an identical doc we didn't (raced/unpooled) — link it.
    if (review.google?.reviewName) {
      stats.skipped += 1;
      return;
    }
    markUsed(pool, String(review._id));
    await linkExisting(review, mapped);
    stats.linked += 1;
    return;
  }
  setGoogleFields(review, mapped);
  await review.save();
  try {
    await processReview(review); // AI failures are captured on the doc, never thrown
  } catch (err) {
    syncLog("warn", "processReview failed", { review: String(review._id), error: errMessage(err) });
  }
  stats.created += 1;
}

function setGoogleFields(doc: ReviewDocument, mapped: MappedGoogleReview): void {
  doc.set("google.reviewName", mapped.google.reviewName);
  doc.set("google.updateTime", mapped.google.updateTime);
  if (mapped.google.replyUpdateTime) doc.set("google.replyUpdateTime", mapped.google.replyUpdateTime);
}

/**
 * Attach a previously imported doc to its API review: Google's ids + exact
 * createTime replace the Maps id and the approximate ("3 months ago") date. The
 * dedupeHash is recomputed the way importReview hashes API reviews. AI is NOT
 * re-run — the content is the same review.
 */
async function linkExisting(reviewDoc: ReviewDocument, mapped: MappedGoogleReview): Promise<void> {
  const doc = withSubdocs(reviewDoc);
  setGoogleFields(doc, mapped);
  doc.externalReviewId = mapped.input.externalReviewId;
  doc.reviewedAt = mapped.input.reviewedAt;
  doc.source = "google";
  doc.dedupeHash = computeDedupeHash(
    doc.projectId,
    { name: doc.author?.name ?? undefined },
    doc.rating,
    doc.text,
    doc.externalReviewId ?? undefined,
  );
  applyGoogleReply(doc, mapped);
  await doc.save();
}

/**
 * The owner replied on Google outside this service. If our reply isn't posted,
 * Google's reply wins: archive ours and record Google's as imported + posted.
 * If ours is already posted, only remember Google's reply timestamp.
 */
function applyGoogleReply(reviewDoc: ReviewDocument, mapped: MappedGoogleReview): void {
  const owner = mapped.input.ownerResponse;
  if (!owner) return;
  const doc = withSubdocs(reviewDoc);
  if (mapped.google.replyUpdateTime) doc.set("google.replyUpdateTime", mapped.google.replyUpdateTime);
  if (doc.publishing.status === "posted") return;

  const when = owner.postedAt ?? new Date();
  archivePriorReply(doc, "replied-on-google");
  doc.reply.status = "draft";
  doc.reply.body = owner.text;
  doc.reply.source = "imported";
  doc.reply.generatedAt = when;
  doc.reply.model = undefined;
  doc.reply.editedAt = undefined;
  doc.reply.editedBy = undefined;
  doc.reply.error = undefined;
  doc.approval.status = "approved";
  doc.approval.approvedAt = when;
  doc.approval.approvedBy = "operator";
  doc.publishing.status = "posted";
  doc.publishing.method = "manual";
  doc.publishing.postedAt = when;
  doc.publishing.postedBy = "operator";
  doc.publishing.note = "Replied on Google outside the service";
  doc.publishing.error = undefined;
}

const timeOf = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/** Apply Google-side changes to an already-synced doc. Returns true when something changed. */
async function applyGoogleUpdate(reviewDoc: ReviewDocument, mapped: MappedGoogleReview): Promise<boolean> {
  const doc = withSubdocs(reviewDoc);
  const contentChanged = timeOf(doc.google?.updateTime) !== mapped.google.updateTime.getTime();
  const replyChanged = timeOf(doc.google?.replyUpdateTime) !== timeOf(mapped.google.replyUpdateTime);
  if (!contentChanged && !replyChanged) return false;

  const { input } = mapped;
  let textOrRatingChanged = false;
  if (contentChanged) {
    textOrRatingChanged = doc.text !== input.text || doc.rating !== input.rating;
    doc.text = input.text;
    doc.rating = input.rating;
    doc.author = { name: input.author.name };
    doc.dedupeHash = computeDedupeHash(doc.projectId, input.author, input.rating, input.text, input.externalReviewId);
    doc.set("google.updateTime", mapped.google.updateTime);
  }
  if (replyChanged) {
    if (input.ownerResponse) applyGoogleReply(doc, mapped);
    else doc.set("google.replyUpdateTime", undefined); // reply removed on Google; our state stands
  }
  await doc.save();

  if (textOrRatingChanged) {
    const posted = doc.publishing.status === "posted";
    const approved = doc.approval.status === "approved";
    const unapprovedAiDraft =
      !posted &&
      !approved &&
      (doc.reply.source === "ai" || (doc.reply.status === "failed" && !doc.reply.body?.trim()));

    if (!posted && approved) {
      // Keep the reply, but the client must re-check it against the edited review.
      archivePriorReply(doc, "review-edited");
      resetApproval(doc);
      await doc.save();
    }
    await reanalyzeReview(doc);
    if (unapprovedAiDraft) await regenerateReply(doc, { by: "operator" });
  }
  return true;
}
