import { Schema, model, type HydratedDocument, type InferSchemaType, type Types } from "mongoose";

export const EMAIL_STATUSES = ["queued", "processing", "sent", "failed"] as const;
export type EmailStatus = (typeof EMAIL_STATUSES)[number];

// Total send attempts before a transient failure becomes terminal. Shared by the
// schema default and the worker's claim query so the two never drift.
export const MAX_ATTEMPTS = 3;

/**
 * One row per send request — this collection is both the work queue and the
 * audit log. It stores the request *as received*; the worker renders the final
 * MIME in-memory (rendered output is not persisted).
 */
const emailSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },

    // Recipient + the resolved sender (copied from the project at enqueue time).
    to: { type: String, required: true },
    from: { type: String, required: true },
    // Optional Reply-To (e.g. a contact-form submitter's address).
    replyTo: { type: String },

    // Content, exactly one shape. Raw: subject + one of html/text/markdown.
    // Template: templateName (+ variables); subject/body come from the template.
    subject: { type: String, default: "" },
    html: { type: String },
    text: { type: String },
    markdown: { type: String },
    templateName: { type: String },
    variables: { type: Schema.Types.Mixed },

    // Optional caller-supplied dedupe key (see the partial unique index below).
    idempotencyKey: { type: String },

    status: { type: String, enum: EMAIL_STATUSES, default: "queued" },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: MAX_ATTEMPTS },
    // When the current retry becomes eligible; also the initial send time.
    nextAttemptAt: { type: Date, default: () => new Date() },
    // Set when a worker claims the row; used to reclaim crash-orphaned rows.
    lockedAt: { type: Date },

    // Send outcome.
    provider: { type: String },
    providerMessageId: { type: String },
    lastError: { type: String },
    sentAt: { type: Date },
  },
  { timestamps: true },
);

// Drives the worker's claim query (queued + due retries).
emailSchema.index({ status: 1, nextAttemptAt: 1 });
// Drives crash recovery (stale `processing` rows).
emailSchema.index({ status: 1, lockedAt: 1 });
// Idempotency: at most one email per (project, idempotencyKey). Partial so the
// many rows without a key don't collide on a shared null.
emailSchema.index(
  { projectId: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);

emailSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type EmailDoc = InferSchemaType<typeof emailSchema> & { _id: Types.ObjectId };
// A live Mongoose document (has .save(), etc.) — what queries return.
export type EmailDocument = HydratedDocument<InferSchemaType<typeof emailSchema>>;

export const Email = model("Email", emailSchema);
