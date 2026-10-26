import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from "mongoose";

export const SYNC_STATUSES = ["idle", "running", "ok", "error"] as const;
export type SyncStatus = (typeof SYNC_STATUSES)[number];

/**
 * A Project is one consuming website. It owns an API key and a fixed sender
 * address, so a project can only ever send as itself — callers never pass `from`.
 */
const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // e.g. "projectx@minteksoftware.com" — must be on a domain verified in SES.
    // Optional: review-only clients never send email, so they need no sender.
    fromAddress: { type: String, required: false, trim: true, lowercase: true },
    // Optional display name, e.g. "Project X" → From: "Project X <projectx@...>".
    fromName: { type: String, default: "" },
    // Free-text business voice/tone hints the AI uses when drafting review replies.
    replyGuidelines: { type: String, default: "" },
    apiKeyHash: { type: String, required: true, unique: true },
    apiKeyLast4: { type: String, required: true },
    active: { type: Boolean, default: true },

    // --- Google Business Profile link (OPERATOR-only; never on a client surface) ---
    google: {
      accountName: { type: String }, // "accounts/{id}"
      locationName: { type: String }, // "locations/{id}"
      locationTitle: { type: String },
      placeId: { type: String },
      syncEnabled: { type: Boolean, default: false },
      lastSyncedAt: { type: Date }, // start time of the last successful sync
      lastSyncStatus: { type: String, enum: SYNC_STATUSES, default: "idle" },
      lastSyncError: { type: String },
      lastSyncStats: {
        fetched: { type: Number },
        created: { type: Number },
        updated: { type: Number },
        linked: { type: Number },
        skipped: { type: Number },
      },
      // Per-project sync lock; a lock older than the stale window is reclaimable.
      syncLockedAt: { type: Date },
    },
  },
  { timestamps: true },
);

// One Google location maps to at most one project. Partial so unlinked projects
// (no locationName) don't collide.
projectSchema.index(
  { "google.locationName": 1 },
  { unique: true, partialFilterExpression: { "google.locationName": { $type: "string" } } },
);

projectSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    // Never expose the key hash over the API.
    delete ret.apiKeyHash;
    delete ret.__v;
    return ret;
  },
});

export type ProjectDoc = InferSchemaType<typeof projectSchema> & { _id: Types.ObjectId };
export type ProjectDocument = HydratedDocument<InferSchemaType<typeof projectSchema>>;

export const Project = model("Project", projectSchema);
