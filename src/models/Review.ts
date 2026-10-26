import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from "mongoose";

// Distinct state dimensions — kept separate on purpose. A review moves through
// analysis, then reply drafting, then client approval, then operator publishing;
// collapsing these into a single `status` would lose information (e.g. an
// approved reply that hasn't been posted yet).
export const ANALYSIS_STATUSES = ["pending", "processing", "ready", "failed"] as const;
export const REPLY_STATUSES = ["pending", "generating", "draft", "failed"] as const;
export const APPROVAL_STATUSES = ["awaiting_client", "approved"] as const;
export const PUBLISHING_STATUSES = ["unpublished", "posted"] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];
export type ReplyStatus = (typeof REPLY_STATUSES)[number];
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];
export type PublishingStatus = (typeof PUBLISHING_STATUSES)[number];

/**
 * One row per review for a client business, scoped by `projectId`. Stores the
 * review verbatim (client-visible), the AI analysis + drafted reply, and the
 * approval/publishing lifecycle. Internal fields (source, externalReviewId,
 * dedupeHash, publishing, replyHistory, errors/attempts) are NEVER sent to the
 * client — use `toClientView` for the client surface.
 */
const reviewSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },

    // --- INTERNAL (operator-only) ---
    source: { type: String, enum: ["manual", "google"], default: "manual" },
    // API-synced reviews: the Business Profile API reviewId. HTML-imported
    // reviews: Google Maps' `data-review-id`, a DIFFERENT identifier that must
    // never be used for API calls (use google.reviewName).
    externalReviewId: { type: String },
    dedupeHash: { type: String, required: true }, // MVP dedup key

    // Business Profile API linkage. Set ONLY by the API sync (services/google/sync.ts).
    google: {
      reviewName: { type: String }, // "accounts/A/locations/L/reviews/R"
      updateTime: { type: Date },
      replyUpdateTime: { type: Date },
    },

    // --- CLIENT-VISIBLE review content (stored verbatim, never edited by AI) ---
    author: {
      name: { type: String },
    },
    rating: { type: Number, min: 1, max: 5, required: true },
    // Rating-only reviews carry no text; store an empty string rather than
    // requiring a value.
    text: { type: String, default: "" },
    reviewedAt: { type: Date },
    language: { type: String },

    // --- AI analysis (client-visible, minus error/attempts/model) ---
    analysis: {
      status: { type: String, enum: ANALYSIS_STATUSES, default: "pending" },
      sentiment: { type: String },
      topics: { type: [String], default: undefined },
      summary: { type: String },
      suggestedTone: { type: String },
      model: { type: String },
      generatedAt: { type: Date },
      error: { type: String },
      attempts: { type: Number, default: 0 },
    },

    // --- Drafted reply (client-visible body/status/timestamps) ---
    reply: {
      status: { type: String, enum: REPLY_STATUSES, default: "pending" },
      body: { type: String, default: "" },
      source: { type: String, enum: ["ai", "edited", "imported"] },
      model: { type: String },
      generatedAt: { type: Date },
      editedAt: { type: Date },
      editedBy: { type: String, enum: ["client", "operator"] },
      attempts: { type: Number, default: 0 },
      error: { type: String },
    },

    // --- Approval (client approves the REPLY, not the review) ---
    approval: {
      status: { type: String, enum: APPROVAL_STATUSES, default: "awaiting_client" },
      approvedAt: { type: Date },
      approvedBy: { type: String, enum: ["client", "operator"] },
    },

    // --- Publishing (INTERNAL — never sent to the client) ---
    publishing: {
      status: { type: String, enum: PUBLISHING_STATUSES, default: "unpublished" },
      postedAt: { type: Date },
      postedBy: { type: String },
      method: { type: String, enum: ["manual", "google_api"], default: "manual" },
      note: { type: String },
      externalResponseId: { type: String },
      // Last "Post to Google" failure (cleared on success) + how many posts failed.
      error: { type: String },
      attempts: { type: Number, default: 0 },
    },

    // --- Audit trail of prior reply versions (INTERNAL) ---
    replyHistory: [
      {
        body: { type: String },
        model: { type: String },
        source: { type: String },
        generatedAt: { type: Date },
        reason: { type: String },
      },
    ],
  },
  { timestamps: true },
);

// Newest-first listing per project.
reviewSchema.index({ projectId: 1, createdAt: -1 });
// The operator "approved replies" queue (approved + not yet posted).
reviewSchema.index({ projectId: 1, "approval.status": 1, "publishing.status": 1 });
// MVP dedup: at most one review per (project, content hash).
reviewSchema.index({ projectId: 1, dedupeHash: 1 }, { unique: true });
// Google id dedup — partial so the many rows without an id don't collide on null.
reviewSchema.index(
  { projectId: 1, externalReviewId: 1 },
  { unique: true, partialFilterExpression: { externalReviewId: { $type: "string" } } },
);
// One doc per Google API review per project.
reviewSchema.index(
  { projectId: 1, "google.reviewName": 1 },
  { unique: true, partialFilterExpression: { "google.reviewName": { $type: "string" } } },
);

reviewSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type ReviewDoc = InferSchemaType<typeof reviewSchema> & { _id: Types.ObjectId };
// A live Mongoose document (has .save(), etc.) — what queries return.
export type ReviewDocument = HydratedDocument<InferSchemaType<typeof reviewSchema>>;

export const Review = model("Review", reviewSchema);

/**
 * Projects a review down to ONLY the fields a client may see. Never exposes
 * internal mechanics (source, externalReviewId, dedupeHash, google, publishing,
 * replyHistory) or noisy operational fields (analysis.error/attempts,
 * reply.error/attempts). This is the single enforcement point for the client
 * projection — client routes must always respond through it.
 */
export function toClientView(review: ReviewDocument) {
  return {
    id: review._id.toString(),
    author: { name: review.author?.name },
    rating: review.rating,
    text: review.text,
    reviewedAt: review.reviewedAt,
    language: review.language,
    analysis: {
      status: review.analysis?.status,
      sentiment: review.analysis?.sentiment,
      topics: review.analysis?.topics,
      summary: review.analysis?.summary,
      suggestedTone: review.analysis?.suggestedTone,
    },
    reply: {
      status: review.reply?.status,
      body: review.reply?.body,
      generatedAt: review.reply?.generatedAt,
      editedAt: review.reply?.editedAt,
    },
    approval: {
      status: review.approval?.status,
      approvedAt: review.approval?.approvedAt,
    },
    createdAt: review.get("createdAt") as Date,
    updatedAt: review.get("updatedAt") as Date,
  };
}
