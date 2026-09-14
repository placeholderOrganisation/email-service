import crypto from "node:crypto";
import type { Types } from "mongoose";

/** trim + collapse internal whitespace + lowercase, so trivial edits collapse. */
function normalize(value: string | undefined | null): string {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/**
 * A stable dedup key for a review within a project. Two imports of the same
 * author + rating + text (ignoring case/whitespace) produce the same hash, so
 * re-importing is idempotent. Not security-sensitive — sha256 is just a compact,
 * collision-resistant fingerprint.
 *
 * When an `externalReviewId` is present (e.g. imported from Google) it is folded
 * in so that distinct source reviews stay unique even with identical, or empty,
 * text — rating-only reviews from the same author+rating would otherwise collide
 * on the unique {projectId, dedupeHash} index and the second would be dropped.
 * Appended only when present, so manual (id-less) hashes are unchanged.
 */
export function computeDedupeHash(
  projectId: Types.ObjectId | string,
  author: { name?: string } | undefined,
  rating: number,
  text: string,
  externalReviewId?: string,
): string {
  let payload = `${String(projectId)}|${normalize(author?.name)}|${rating}|${normalize(text)}`;
  if (externalReviewId) payload += `|${normalize(externalReviewId)}`;
  return crypto.createHash("sha256").update(payload).digest("hex");
}
