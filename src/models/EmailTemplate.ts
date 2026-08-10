import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/**
 * A reusable, per-project template. `body` holds HTML or Markdown depending on
 * `format`; `{{variables}}` in `subject`/`body` are resolved at send time.
 */
const emailTemplateSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    name: { type: String, required: true, trim: true },
    subject: { type: String, required: true },
    format: { type: String, enum: ["html", "markdown"], required: true },
    body: { type: String, required: true },
  },
  { timestamps: true },
);

// A template name is unique within a project (but reusable across projects).
emailTemplateSchema.index({ projectId: 1, name: 1 }, { unique: true });

emailTemplateSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type EmailTemplateDoc = InferSchemaType<typeof emailTemplateSchema> & { _id: Types.ObjectId };

export const EmailTemplate = model("EmailTemplate", emailTemplateSchema);
