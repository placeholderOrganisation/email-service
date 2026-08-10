import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/**
 * A Project is one consuming website. It owns an API key and a fixed sender
 * address, so a project can only ever send as itself — callers never pass `from`.
 */
const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // e.g. "projectx@minteksoftware.com" — must be on a domain verified in SES.
    fromAddress: { type: String, required: true, trim: true, lowercase: true },
    // Optional display name, e.g. "Project X" → From: "Project X <projectx@...>".
    fromName: { type: String, default: "" },
    apiKeyHash: { type: String, required: true, unique: true },
    apiKeyLast4: { type: String, required: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
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

export const Project = model("Project", projectSchema);
