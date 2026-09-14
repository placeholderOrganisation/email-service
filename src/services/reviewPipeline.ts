import type { Types } from "mongoose";
import { Project } from "../models/Project.js";
import { Review, type ReviewDocument } from "../models/Review.js";
import type { ReviewImportInput } from "../schemas/reviews.js";
import { computeDedupeHash } from "../utils/reviewDedupe.js";
import { analyzeReview, generateReply } from "./ai.js";
import { getProvider } from "./reviewProvider.js";
import { badRequest, conflict } from "../utils/errors.js";

// Mongoose always initializes these nested subpaths (they carry sub-defaults),
// but InferSchemaType types them as optional. This view narrows them to
// non-null so the pipeline can assign lifecycle fields without a sea of `!`.
// The underlying document is untouched — nested-path assignment is still tracked
// and persisted by Mongoose.
type ReviewSubdocs = ReviewDocument & {
  analysis: NonNullable<ReviewDocument["analysis"]>;
  reply: NonNullable<ReviewDocument["reply"]>;
  approval: NonNullable<ReviewDocument["approval"]>;
  publishing: NonNullable<ReviewDocument["publishing"]>;
  replyHistory: NonNullable<ReviewDocument["replyHistory"]>;
};

const withSubdocs = (doc: ReviewDocument): ReviewSubdocs => doc as ReviewSubdocs;

/**
 * Idempotently import one review into a project. If a review with the same
 * content hash (or the same externalReviewId, when provided) already exists, the
 * existing doc is returned untouched — re-importing never creates a duplicate.
 * Mongo's unique-index E11000 (a concurrent insert of the same key) is handled
 * as the same idempotent outcome.
 *
 * Returns { review, created } — the caller runs `processReview` only on created
 * docs.
 */
export async function importReview(
  projectId: Types.ObjectId,
  input: ReviewImportInput,
): Promise<{ review: ReviewDocument; created: boolean }> {
  const dedupeHash = computeDedupeHash(projectId, input.author, input.rating, input.text, input.externalReviewId);

  const existing = await findExisting(projectId, dedupeHash, input.externalReviewId);
  if (existing) return { review: existing, created: false };

  try {
    const review = await Review.create({
      projectId,
      source: input.source ?? "manual",
      externalReviewId: input.externalReviewId,
      dedupeHash,
      author: { name: input.author.name },
      rating: input.rating,
      text: input.text,
      reviewedAt: input.reviewedAt,
      language: input.language,
      // Preserve an already-posted owner response: record it as an imported,
      // pre-approved, already-posted reply. `processReview` sees the "imported"
      // source and skips AI reply generation (analysis still runs).
      ...(input.ownerResponse
        ? ownerResponseFields(input.ownerResponse.text, input.ownerResponse.postedAt)
        : {}),
    });
    return { review, created: true };
  } catch (err) {
    // A concurrent insert won the unique index — treat as idempotent and return
    // the winner.
    if (isDuplicateKeyError(err)) {
      const winner = await findExisting(projectId, dedupeHash, input.externalReviewId);
      if (winner) return { review: winner, created: false };
    }
    throw err;
  }
}

async function findExisting(
  projectId: Types.ObjectId,
  dedupeHash: string,
  externalReviewId?: string,
): Promise<ReviewDocument | null> {
  const or: Record<string, unknown>[] = [{ dedupeHash }];
  if (externalReviewId) or.push({ externalReviewId });
  return Review.findOne({ projectId, $or: or });
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Runs analysis + reply drafting for a freshly imported (or re-analyzed) review.
 * SYNCHRONOUS by design: Render's free tier sleeps when idle, so there's no
 * reliable background worker — we do the work inline on import/analyze and give
 * the operator immediate feedback. Reused by import + operator "analyze".
 *
 * Failures are captured on the doc (analysis/reply status = "failed" + error)
 * rather than thrown, so a single review's AI failure never aborts a bulk import.
 */
export async function processReview(reviewDoc: ReviewDocument): Promise<ReviewDocument> {
  const doc = withSubdocs(reviewDoc);

  // A review imported WITH an existing owner response already carries a
  // pre-approved, already-posted reply. We still run analysis (it's useful), but
  // must never overwrite the preserved reply with an AI draft.
  const hasImportedReply = doc.reply?.source === "imported";

  // --- Analysis ---
  doc.analysis.status = "processing";
  await doc.save();

  let analysis: Awaited<ReturnType<typeof analyzeReview>> | undefined;
  try {
    analysis = await analyzeReview({
      rating: doc.rating,
      text: doc.text,
      author: doc.author,
      language: doc.language,
    });
    doc.analysis.status = "ready";
    doc.analysis.sentiment = analysis.sentiment;
    doc.analysis.topics = analysis.topics;
    doc.analysis.summary = analysis.summary;
    doc.analysis.suggestedTone = analysis.suggestedTone;
    doc.analysis.model = analysis.model;
    doc.analysis.generatedAt = analysis.generatedAt;
    doc.analysis.error = undefined;
  } catch (err) {
    doc.analysis.status = "failed";
    doc.analysis.error = errMessage(err);
    doc.analysis.attempts = (doc.analysis.attempts ?? 0) + 1;
    await doc.save();
    return doc;
  }

  // Imported owner response: analysis is stored, but the preserved reply /
  // approval / publishing state stands. Skip AI reply generation entirely.
  if (hasImportedReply) {
    await doc.save();
    return doc;
  }

  // --- Reply drafting ---
  doc.reply.status = "generating";
  await doc.save();

  try {
    const project = await Project.findById(doc.projectId);
    const recentReplies = await loadRecentReplyBodies(doc.projectId, doc._id);
    const reply = await generateReply({
      review: { rating: doc.rating, text: doc.text, author: doc.author },
      analysis: {
        sentiment: analysis.sentiment,
        suggestedTone: analysis.suggestedTone,
        topics: analysis.topics,
        summary: analysis.summary,
      },
      project: { name: project?.name, replyGuidelines: project?.replyGuidelines },
      recentReplies,
    });
    doc.reply.body = reply.body;
    doc.reply.model = reply.model;
    doc.reply.generatedAt = reply.generatedAt;
    doc.reply.source = "ai";
    doc.reply.status = "draft";
    doc.reply.error = undefined;
  } catch (err) {
    doc.reply.status = "failed";
    doc.reply.error = errMessage(err);
    doc.reply.attempts = (doc.reply.attempts ?? 0) + 1;
  }

  await doc.save();
  return doc;
}

/**
 * Re-draft the reply with AI. Preserves the prior reply in `replyHistory` and
 * resets approval (a regenerated reply is a new draft the client must re-approve).
 */
export async function regenerateReply(
  reviewDoc: ReviewDocument,
  { by }: { by: "client" | "operator" },
): Promise<ReviewDocument> {
  void by;
  const doc = withSubdocs(reviewDoc);
  if (doc.publishing.status === "posted") {
    throw conflict("Reply already posted; cannot regenerate");
  }
  archivePriorReply(doc, "regenerate");

  doc.reply.status = "generating";
  const project = await Project.findById(doc.projectId);
  try {
    const recentReplies = await loadRecentReplyBodies(doc.projectId, doc._id);
    const reply = await generateReply({
      review: { rating: doc.rating, text: doc.text, author: doc.author },
      analysis: {
        sentiment: doc.analysis?.sentiment ?? "",
        suggestedTone: doc.analysis?.suggestedTone ?? "",
        topics: doc.analysis?.topics ?? undefined,
        summary: doc.analysis?.summary ?? undefined,
      },
      project: { name: project?.name, replyGuidelines: project?.replyGuidelines },
      recentReplies,
    });
    doc.reply.body = reply.body;
    doc.reply.model = reply.model;
    doc.reply.generatedAt = reply.generatedAt;
    doc.reply.source = "ai";
    doc.reply.status = "draft";
    doc.reply.editedAt = undefined;
    doc.reply.editedBy = undefined;
    doc.reply.error = undefined;
  } catch (err) {
    doc.reply.status = "failed";
    doc.reply.error = errMessage(err);
    doc.reply.attempts = (doc.reply.attempts ?? 0) + 1;
  }

  resetApproval(doc);
  await doc.save();
  return doc;
}

/**
 * Manually edit the reply body. Archives the prior version, marks the reply as
 * edited. Editing NEVER approves; if the reply was already approved, approval is
 * reset (the client must re-approve their edited text).
 */
export async function editReply(
  reviewDoc: ReviewDocument,
  { body, by }: { body: string; by: "client" | "operator" },
): Promise<ReviewDocument> {
  const doc = withSubdocs(reviewDoc);
  if (doc.publishing.status === "posted") {
    throw conflict("Reply already posted; cannot edit");
  }
  archivePriorReply(doc, "edit");

  doc.reply.body = body;
  doc.reply.source = "edited";
  doc.reply.status = "draft";
  doc.reply.editedAt = new Date();
  doc.reply.editedBy = by;
  doc.reply.error = undefined;

  resetApproval(doc);
  await doc.save();
  return doc;
}

/** Client/operator approves the current draft reply. Requires a non-empty draft. */
export async function approveReply(
  reviewDoc: ReviewDocument,
  { by }: { by: "client" | "operator" },
): Promise<ReviewDocument> {
  const doc = withSubdocs(reviewDoc);
  if (doc.publishing.status === "posted") {
    throw conflict("Reply already posted");
  }
  if (doc.reply.status !== "draft" || !doc.reply.body?.trim()) {
    throw badRequest("A non-empty draft reply is required before approval");
  }
  doc.approval.status = "approved";
  doc.approval.approvedAt = new Date();
  doc.approval.approvedBy = by;
  await doc.save();
  return doc;
}

/**
 * Operator marks an approved reply as posted. Requires prior approval; idempotent
 * if already posted. Runs the project's review provider (manual = no-op for MVP)
 * and records how/when it was published.
 */
export async function markPosted(
  reviewDoc: ReviewDocument,
  { by, note }: { by: string; note?: string },
): Promise<ReviewDocument> {
  const doc = withSubdocs(reviewDoc);
  if (doc.publishing.status === "posted") {
    return doc; // idempotent no-op
  }
  if (doc.approval.status !== "approved") {
    throw badRequest("Reply must be approved before it can be marked posted");
  }

  const project = await Project.findById(doc.projectId);
  const provider = project ? getProvider(project) : undefined;
  const result = provider
    ? await provider.publishReply({
        reviewId: doc._id.toString(),
        externalReviewId: doc.externalReviewId ?? undefined,
        body: doc.reply.body ?? "",
      })
    : { method: "manual" as const };

  doc.publishing.status = "posted";
  doc.publishing.postedAt = new Date();
  doc.publishing.postedBy = by;
  doc.publishing.method = result.method;
  if (note !== undefined) doc.publishing.note = note;
  if (result.externalResponseId) doc.publishing.externalResponseId = result.externalResponseId;
  await doc.save();
  return doc;
}

// ---- helpers ----

/**
 * Build the reply/approval/publishing subdocuments for an imported, already-posted
 * owner response. Keeps it OUT of the needs-reply and approved-to-post queues
 * (publishing.status is "posted", not "unpublished") and marks the reply as
 * "imported" so `processReview` never regenerates it.
 */
function ownerResponseFields(text: string, postedAt?: Date) {
  const when = postedAt ?? new Date();
  return {
    reply: {
      status: "draft" as const,
      body: text,
      source: "imported" as const,
      generatedAt: when,
    },
    approval: {
      status: "approved" as const,
      approvedAt: when,
      approvedBy: "operator" as const,
    },
    publishing: {
      status: "posted" as const,
      postedAt: when,
      postedBy: "operator",
      method: "manual" as const,
      note: "Imported existing owner response",
    },
  };
}

/** Push the current reply body (if any) onto the audit trail before overwriting. */
function archivePriorReply(doc: ReviewSubdocs, reason: string): void {
  if (doc.reply?.body?.trim()) {
    doc.replyHistory.push({
      body: doc.reply.body,
      model: doc.reply.model,
      source: doc.reply.source,
      generatedAt: doc.reply.generatedAt,
      reason,
    });
  }
}

function resetApproval(doc: ReviewSubdocs): void {
  doc.approval.status = "awaiting_client";
  doc.approval.approvedAt = undefined;
  doc.approval.approvedBy = undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Last few non-empty reply bodies in this project, excluding the current review. */
async function loadRecentReplyBodies(
  projectId: Types.ObjectId,
  excludeId: Types.ObjectId,
): Promise<string[]> {
  const docs = await Review.find({
    projectId,
    _id: { $ne: excludeId },
    "reply.body": { $nin: [null, ""] },
  })
    .sort({ updatedAt: -1 })
    .limit(5)
    .select("reply.body")
    .lean();
  return docs
    .map((d) => (typeof d.reply?.body === "string" ? d.reply.body.trim() : ""))
    .filter(Boolean);
}
