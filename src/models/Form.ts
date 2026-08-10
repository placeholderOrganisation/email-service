import { Schema, model, type InferSchemaType, type Types } from "mongoose";

/**
 * A public contact form. Its `formId` is safe to embed in a static site: it can
 * ONLY submit this form to the fixed `toAddress` using the fixed templates — it
 * cannot send arbitrary email. Abuse is bounded by the origin allowlist, a
 * honeypot, and per-IP rate limiting on the submit route.
 */
const formSchema = new Schema(
  {
    projectId: { type: Schema.Types.ObjectId, ref: "Project", required: true, index: true },
    // Public, embeddable identifier (e.g. "frm_ab12…"). Not a secret.
    formId: { type: String, required: true, unique: true },
    name: { type: String, required: true, trim: true },
    // Where submissions are emailed (your inbox). Any address — recipients need
    // no verification, only your sending domain does.
    toAddress: { type: String, required: true, trim: true },
    // Browser origins allowed to submit, e.g. ["https://minteksoftware.com"].
    // Empty = allow any origin (rely on honeypot + rate limit only).
    allowedOrigins: { type: [String], default: [] },
    // Template emailed to you on each submission.
    notifyTemplate: { type: String, default: "contact-notification" },
    // Optional auto-acknowledgment emailed to the submitter. Off by default to
    // avoid being used to send unsolicited mail to arbitrary addresses.
    ackTemplate: { type: String, default: "" },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

formSchema.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret: Record<string, unknown>) => {
    delete ret.__v;
    return ret;
  },
});

export type FormDoc = InferSchemaType<typeof formSchema> & { _id: Types.ObjectId };

export const Form = model("Form", formSchema);
