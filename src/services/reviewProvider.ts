import type { ProjectDoc } from "../models/Project.js";
import { getGoogleClient } from "./google/client.js";

export interface PublishReplyInput {
  reviewId: string;
  externalReviewId?: string;
  // Business Profile API resource name ("accounts/A/locations/L/reviews/R").
  // Never derived from externalReviewId — HTML imports carry a Maps id there.
  googleReviewName?: string;
  body: string;
}

export interface PublishReplyResult {
  method: "manual" | "google_api";
  externalResponseId?: string;
  replyUpdateTime?: Date;
}

export interface ReviewProvider {
  publishReply(input: PublishReplyInput): Promise<PublishReplyResult>;
}

/**
 * Manual provider: the operator posts the approved reply by hand, then marks it
 * posted. `publishReply` is a no-op that just reports the method used.
 */
export const manualProvider: ReviewProvider = {
  async publishReply(): Promise<PublishReplyResult> {
    return { method: "manual" };
  },
};

/**
 * Posts the reply through the Business Profile API (PUT .../reply overwrites,
 * so a retry after an ambiguous failure is safe). Throws GoogleApiError on failure.
 */
export const googleProvider: ReviewProvider = {
  async publishReply(input: PublishReplyInput): Promise<PublishReplyResult> {
    if (!input.googleReviewName) throw new Error("Review is not linked to a Google review");
    const reply = await getGoogleClient().updateReply(input.googleReviewName, input.body);
    return {
      method: "google_api",
      replyUpdateTime: reply.updateTime ? new Date(reply.updateTime) : new Date(),
    };
  },
};

/**
 * The provider for an explicit, operator-triggered publish: Google when the
 * project is linked to a Business Profile location, manual otherwise.
 * markPosted does NOT use this — it is always manual record-keeping.
 */
export function getProvider(project: ProjectDoc): ReviewProvider {
  return project.google?.locationName ? googleProvider : manualProvider;
}
