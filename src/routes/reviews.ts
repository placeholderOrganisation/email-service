import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { requireApiKey } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { replyUpdateSchema } from "../schemas/index.js";
import { Review, toClientView, type ReviewDocument } from "../models/Review.js";
import { approveReply, editReply, regenerateReply } from "../services/reviewPipeline.js";
import { asyncHandler, badRequest, notFound } from "../utils/errors.js";

const router = Router();

// Every client route is authenticated by a per-project API key and scoped to
// that project. Cross-project ids 404 (never 403) so existence isn't leaked.
router.use(requireApiKey);

/**
 * Optional ?status filter, mapped to a client-facing stage:
 *   - needs_review: a draft reply is waiting for the client to approve
 *                   (reply.status === "draft" && approval.status === "awaiting_client")
 *   - approved:     the client has approved the reply (approval.status === "approved")
 * Anything else is rejected. Omit the filter to list everything.
 */
const CLIENT_STATUS_FILTERS: Record<string, Record<string, unknown>> = {
  needs_review: { "reply.status": "draft", "approval.status": "awaiting_client" },
  approved: { "approval.status": "approved" },
};

/** Load a review scoped to the caller's project, or 404. */
async function loadScoped(id: string, projectId: unknown): Promise<ReviewDocument> {
  if (!isValidObjectId(id)) throw notFound("Review not found");
  const review = await Review.findOne({ _id: id, projectId });
  if (!review) throw notFound("Review not found");
  return review;
}

/** List this project's reviews (client projection). */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const status = req.query.status as string | undefined;
    if (status && !(status in CLIENT_STATUS_FILTERS)) {
      throw badRequest(`status must be one of: ${Object.keys(CLIENT_STATUS_FILTERS).join(", ")}`);
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const reviews = await Review.find({
      projectId: req.project!._id,
      ...(status ? CLIENT_STATUS_FILTERS[status] : {}),
    })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(reviews.map(toClientView));
  }),
);

/** Get one review (client projection). */
router.get(
  "/:id",
  asyncHandler(async (req, res) => {
    const review = await loadScoped(req.params.id, req.project!._id);
    res.json(toClientView(review));
  }),
);

/** Edit the drafted reply. Does NOT approve; resets approval if it was approved. */
router.put(
  "/:id/reply",
  validate({ body: replyUpdateSchema }),
  asyncHandler(async (req, res) => {
    const review = await loadScoped(req.params.id, req.project!._id);
    await editReply(review, { body: req.body.body, by: "client" });
    res.json(toClientView(review));
  }),
);

/** Regenerate the drafted reply with AI. Resets approval to awaiting_client. */
router.post(
  "/:id/reply/regenerate",
  asyncHandler(async (req, res) => {
    const review = await loadScoped(req.params.id, req.project!._id);
    await regenerateReply(review, { by: "client" });
    res.json(toClientView(review));
  }),
);

/** Approve the current draft reply. */
router.post(
  "/:id/reply/approve",
  asyncHandler(async (req, res) => {
    const review = await loadScoped(req.params.id, req.project!._id);
    await approveReply(review, { by: "client" });
    res.json(toClientView(review));
  }),
);

export default router;
