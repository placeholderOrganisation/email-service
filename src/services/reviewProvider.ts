import type { ProjectDoc } from "../models/Project.js";

export interface PublishReplyInput {
  reviewId: string;
  externalReviewId?: string;
  body: string;
}

export interface PublishReplyResult {
  method: "manual" | "google_api";
  externalResponseId?: string;
}

export interface ReviewProvider {
  publishReply(input: PublishReplyInput): Promise<PublishReplyResult>;
}

/**
 * MVP provider: publishing is done by hand (operator posts the approved reply on
 * Google, then marks it posted). So `publishReply` is a no-op that just reports
 * the method used.
 */
export const manualProvider: ReviewProvider = {
  async publishReply(): Promise<PublishReplyResult> {
    return { method: "manual" };
  },
};

/**
 * Selects the provider for a project. For now every project uses the manual
 * provider.
 *
 * FUTURE: this is the seam for a GoogleProvider. When Google Business Profile
 * publishing lands, branch here on the project (e.g. a connected Google account
 * / stored OAuth token) and return a `googleProvider` whose `publishReply` calls
 * the Business Profile API and returns { method: "google_api", externalResponseId }.
 * The rest of the pipeline (markPosted) already consumes the result generically.
 */
export function getProvider(_project: ProjectDoc): ReviewProvider {
  return manualProvider;
}
