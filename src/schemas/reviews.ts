import { z } from "zod";

/** A single imported review (operator surface). */
export const reviewImportSchema = z.object({
  author: z.object({ name: z.string().trim().min(1).max(200) }),
  rating: z.number().int().min(1).max(5),
  // Optional: rating-only reviews (a star rating with no written text) are
  // valid. Defaults to "" so downstream code can treat it as a plain string.
  text: z.string().trim().max(5000).optional().default(""),
  // ISO datetime string, coerced to a Date.
  reviewedAt: z.coerce.date().optional(),
  language: z.string().trim().min(1).max(20).optional(),
  externalReviewId: z.string().trim().min(1).max(200).optional(),
  source: z.enum(["manual", "google"]).optional(),
  // An owner response that was ALREADY posted (e.g. previously replied on
  // Google). When present, the review is recorded as already-handled: the reply
  // body is preserved verbatim (source "imported"), auto-approved, and marked
  // posted — so it never enters the needs-reply or approved-to-post queues and
  // is never overwritten by the AI.
  ownerResponse: z
    .object({
      text: z.string().trim().min(1).max(5000),
      // ISO datetime string, coerced to a Date.
      postedAt: z.coerce.date().optional(),
    })
    .optional(),
});

/**
 * Import body: accept EITHER a single review object OR { reviews: [...] } for
 * bulk import. Normalizes to always expose a `.reviews` array via transform.
 */
export const reviewImportBodySchema = z.union([
  z.object({ reviews: z.array(reviewImportSchema).min(1).max(200) }),
  reviewImportSchema,
]);

/** Edit a reply body (client or operator). */
export const replyUpdateSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});

/** Mark an approved reply as posted (operator only). */
export const markPostedSchema = z.object({
  note: z.string().trim().max(2000).optional(),
  externalResponseId: z.string().trim().min(1).max(200).optional(),
});

export type ReviewImportInput = z.infer<typeof reviewImportSchema>;
export type ReviewImportBodyInput = z.infer<typeof reviewImportBodySchema>;
export type ReplyUpdateInput = z.infer<typeof replyUpdateSchema>;
export type MarkPostedInput = z.infer<typeof markPostedSchema>;

/** Normalize the polymorphic import body into a flat list of reviews. */
export function toReviewList(body: ReviewImportBodyInput): ReviewImportInput[] {
  return "reviews" in body ? body.reviews : [body];
}
