import { Email, type EmailDocument } from "../models/Email.js";
import type { Types } from "mongoose";

export interface EnqueueInput {
  projectId: Types.ObjectId;
  to: string;
  from: string;
  replyTo?: string;
  subject?: string;
  html?: string;
  markdown?: string;
  text?: string;
  templateName?: string;
  variables?: Record<string, unknown>;
  idempotencyKey?: string;
}

/**
 * Creates a queued Email row. Shared by the authenticated `/v1/send` route and
 * the public form-submit route so both enqueue identically.
 */
export function enqueueEmail(input: EnqueueInput): Promise<EmailDocument> {
  return Email.create({ ...input, subject: input.subject ?? "" });
}
