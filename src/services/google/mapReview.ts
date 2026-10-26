import type { ReviewImportInput } from "../../schemas/reviews.js";
import type { GoogleReview } from "./client.js";

const STAR_VALUES: Record<string, number> = { ONE: 1, TWO: 2, THREE: 3, FOUR: 4, FIVE: 5 };

const ORIGINAL_MARKER = /\(Original\)/i;
const LEADING_TRANSLATED = /^\(Translated by Google\)\s*/i;
const TRAILING_TRANSLATED = /\n\s*\(Translated by Google\)/i;

/**
 * Google auto-translates comments, e.g.
 *   "(Translated by Google) Great place\n\n(Original)\nExcelente lugar"
 * We keep the reviewer's original-language text: everything after "(Original)"
 * when present; otherwise drop a leading "(Translated by Google)" marker (or a
 * trailing translated section appended after the original).
 */
export function extractOriginalText(comment: string | undefined | null): string {
  const c = (comment ?? "").trim();
  if (!c) return "";
  const original = c.match(ORIGINAL_MARKER);
  if (original?.index !== undefined) {
    const after = c.slice(original.index + original[0].length).trim();
    if (after) return after;
  }
  if (LEADING_TRANSLATED.test(c)) return c.replace(LEADING_TRANSLATED, "").trim();
  const trailing = c.search(TRAILING_TRANSLATED);
  if (trailing > 0) return c.slice(0, trailing).trim();
  return c;
}

export interface MappedGoogleReview {
  input: ReviewImportInput;
  google: { reviewName: string; updateTime: Date; replyUpdateTime?: Date };
}

/** The API reviewId (falls back to the last segment of the resource name). */
export function apiReviewId(review: GoogleReview): string {
  return review.reviewId || review.name.split("/").pop() || review.name;
}

/**
 * Maps a Business Profile API review onto the existing import shape. Returns
 * null for reviews we can't store (STAR_RATING_UNSPECIFIED) — the sync counts
 * those as skipped.
 */
export function mapGoogleReview(review: GoogleReview): MappedGoogleReview | null {
  const rating = STAR_VALUES[review.starRating ?? ""];
  if (!rating) return null;

  const displayName = review.reviewer?.displayName?.trim();
  const name = review.reviewer?.isAnonymous || !displayName ? "Anonymous" : displayName.slice(0, 200);

  const replyText = extractOriginalText(review.reviewReply?.comment);
  const replyUpdateTime = review.reviewReply?.updateTime ? new Date(review.reviewReply.updateTime) : undefined;

  return {
    input: {
      author: { name },
      rating,
      text: extractOriginalText(review.comment),
      reviewedAt: new Date(review.createTime),
      externalReviewId: apiReviewId(review),
      source: "google",
      ...(replyText ? { ownerResponse: { text: replyText, postedAt: replyUpdateTime } } : {}),
    },
    google: {
      reviewName: review.name,
      updateTime: new Date(review.updateTime),
      ...(replyText && replyUpdateTime ? { replyUpdateTime } : {}),
    },
  };
}
