import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { isValidObjectId, type Types } from "mongoose";
import { requireAdminToken } from "../middleware/adminAuth.js";
import { validate } from "../middleware/validate.js";
import {
  projectCreateSchema,
  projectUpdateSchema,
  templateCreateSchema,
  templateUpdateSchema,
  reviewImportBodySchema,
  replyUpdateSchema,
  markPostedSchema,
  toReviewList,
} from "../schemas/index.js";
import { Project } from "../models/Project.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { Form } from "../models/Form.js";
import { Email, EMAIL_STATUSES } from "../models/Email.js";
import { Review } from "../models/Review.js";
import { generateApiKey } from "../utils/apiKey.js";
import { asyncHandler, badRequest, conflict, notFound } from "../utils/errors.js";
import {
  importReview,
  processReview,
  regenerateReply,
  approveReply,
  editReply,
  markPosted,
} from "../services/reviewPipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// The dashboard shell is a static file with no secrets baked in — it prompts
// for the admin token client-side and attaches it to each API call below. So
// this one route is intentionally unauthenticated (like a login page).
router.get(["/", ""], (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/admin/index.html"));
});

const api = Router();
// Admin data is dynamic and per-request — never let the browser cache it.
// (Express auto-ETags JSON, which otherwise yields 304s that the fetch client
// treats as errors since res.ok is false for 304.)
api.use((_req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});
api.use(requireAdminToken);

/** Fields safe to show in a list view — never the rendered content. */
const EMAIL_LIST_FIELDS =
  "to from replyTo subject templateName status attempts maxAttempts provider lastError createdAt sentAt";

async function loadProject(id: string) {
  if (!isValidObjectId(id)) throw notFound("Project not found");
  const project = await Project.findById(id);
  if (!project) throw notFound("Project not found");
  return project;
}

// ---- Projects ----

api.get(
  "/projects",
  asyncHandler(async (_req, res) => {
    const projects = await Project.find().sort({ createdAt: -1 });
    res.json(projects);
  }),
);

api.post(
  "/projects",
  validate({ body: projectCreateSchema }),
  asyncHandler(async (req, res) => {
    const key = generateApiKey();
    const project = await Project.create({
      ...req.body,
      apiKeyHash: key.hash,
      apiKeyLast4: key.last4,
    });
    // The plaintext key is returned exactly once — it's never stored.
    res.status(201).json({ project, apiKey: key.plaintext });
  }),
);

api.get(
  "/projects/:id",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const [templates, forms] = await Promise.all([
      EmailTemplate.find({ projectId: project._id }).sort({ name: 1 }),
      Form.find({ projectId: project._id }).sort({ createdAt: -1 }),
    ]);
    res.json({ project, templates, forms });
  }),
);

api.patch(
  "/projects/:id",
  validate({ body: projectUpdateSchema }),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    Object.assign(project, req.body);
    await project.save();
    res.json(project);
  }),
);

api.post(
  "/projects/:id/rotate-key",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const key = generateApiKey();
    project.apiKeyHash = key.hash;
    project.apiKeyLast4 = key.last4;
    await project.save();
    // The OLD key stops working immediately; the new plaintext is shown once.
    res.json({ apiKey: key.plaintext, apiKeyLast4: key.last4 });
  }),
);

api.delete(
  "/projects/:id",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    // Cascade: a project's templates, forms and send history go with it.
    await Promise.all([
      EmailTemplate.deleteMany({ projectId: project._id }),
      Form.deleteMany({ projectId: project._id }),
      Email.deleteMany({ projectId: project._id }),
    ]);
    await project.deleteOne();
    res.status(204).end();
  }),
);

// ---- Templates (scoped to a project) ----

api.post(
  "/projects/:id/templates",
  validate({ body: templateCreateSchema }),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const exists = await EmailTemplate.exists({ projectId: project._id, name: req.body.name });
    if (exists) throw conflict(`Template "${req.body.name}" already exists`);
    const template = await EmailTemplate.create({ projectId: project._id, ...req.body });
    res.status(201).json(template);
  }),
);

async function loadTemplate(id: string) {
  if (!isValidObjectId(id)) throw notFound("Template not found");
  const template = await EmailTemplate.findById(id);
  if (!template) throw notFound("Template not found");
  return template;
}

api.patch(
  "/templates/:id",
  validate({ body: templateUpdateSchema }),
  asyncHandler(async (req, res) => {
    const template = await loadTemplate(req.params.id);
    Object.assign(template, req.body);
    await template.save();
    res.json(template);
  }),
);

api.delete(
  "/templates/:id",
  asyncHandler(async (req, res) => {
    const template = await loadTemplate(req.params.id);
    await template.deleteOne();
    res.status(204).end();
  }),
);

// ---- Emails ----

api.get(
  "/projects/:id/emails",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);

    const status = req.query.status as string | undefined;
    if (status && !EMAIL_STATUSES.includes(status as (typeof EMAIL_STATUSES)[number])) {
      throw badRequest(`status must be one of: ${EMAIL_STATUSES.join(", ")}`);
    }
    const limit = Math.min(Number(req.query.limit) || 50, 200);

    const emails = await Email.find({ projectId: project._id, ...(status ? { status } : {}) })
      .select(EMAIL_LIST_FIELDS)
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(emails);
  }),
);

async function loadEmail(id: string) {
  if (!isValidObjectId(id)) throw notFound("Email not found");
  const email = await Email.findById(id);
  if (!email) throw notFound("Email not found");
  return email;
}

api.get(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    const email = await loadEmail(req.params.id);
    res.json(email);
  }),
);

api.delete(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    const email = await loadEmail(req.params.id);
    await email.deleteOne();
    res.status(204).end();
  }),
);

// ---- Reviews (operator: full docs, incl. internal fields) ----

/**
 * Optional ?status filter for operator listings, mapped across the lifecycle
 * dimensions:
 *   - needs_review: draft reply awaiting client approval
 *   - approved:     approved but not yet posted (the publish queue)
 *   - posted:       published on the platform
 *   - failed:       analysis or reply generation failed
 */
const OPERATOR_STATUS_FILTERS: Record<string, Record<string, unknown>> = {
  needs_review: { "reply.status": "draft", "approval.status": "awaiting_client" },
  approved: { "approval.status": "approved", "publishing.status": "unpublished" },
  posted: { "publishing.status": "posted" },
  failed: { $or: [{ "analysis.status": "failed" }, { "reply.status": "failed" }] },
};

function reviewFilter(status: string | undefined): Record<string, unknown> {
  if (!status) return {};
  const filter = OPERATOR_STATUS_FILTERS[status];
  if (!filter) throw badRequest(`status must be one of: ${Object.keys(OPERATOR_STATUS_FILTERS).join(", ")}`);
  return filter;
}

async function loadReview(id: string) {
  if (!isValidObjectId(id)) throw notFound("Review not found");
  const review = await Review.findById(id);
  if (!review) throw notFound("Review not found");
  return review;
}

// Import one or many reviews, then run the AI pipeline on the newly-created ones.
// Idempotent: re-importing the same review returns it as a duplicate.
api.post(
  "/projects/:id/reviews",
  validate({ body: reviewImportBodySchema }),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const inputs = toReviewList(req.body);

    const created = [];
    const duplicates = [];
    for (const input of inputs) {
      const { review, created: isNew } = await importReview(project._id, input);
      if (isNew) {
        await processReview(review);
        created.push(review);
      } else {
        duplicates.push(review);
      }
    }
    res.status(201).json({ created, duplicates });
  }),
);

// List a project's reviews (full docs), optionally filtered by lifecycle status.
api.get(
  "/projects/:id/reviews",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const filter = reviewFilter(req.query.status as string | undefined);
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const reviews = await Review.find({ projectId: project._id, ...filter })
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(reviews);
  }),
);

// Scoped "approved replies" queue for a single project (approved + unpublished).
api.get(
  "/projects/:id/replies/approved",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const reviews = await Review.find({
      projectId: project._id,
      "approval.status": "approved",
      "publishing.status": "unpublished",
    }).sort({ "approval.approvedAt": -1 });
    res.json(reviews);
  }),
);

// Cross-project "approved replies" queue — the operator's post-to-platform work
// list (approved + not yet posted), newest approvals first.
api.get(
  "/replies/approved",
  asyncHandler(async (_req, res) => {
    const reviews = await Review.find({
      "approval.status": "approved",
      "publishing.status": "unpublished",
    })
      .sort({ "approval.approvedAt": -1 })
      // The cross-project queue needs the client name per row so the operator
      // knows which business each reply belongs to when posting to Google.
      .populate("projectId", "name");
    const out = reviews.map((review) => {
      const json = review.toJSON() as Record<string, unknown>;
      const proj = review.projectId as unknown as { _id: Types.ObjectId; name?: string } | null;
      if (proj && typeof proj === "object" && "name" in proj) {
        json.projectId = proj._id;
        json.projectName = proj.name;
      }
      return json;
    });
    res.json(out);
  }),
);

// Full review detail.
api.get(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    res.json(review);
  }),
);

// Operator edit of review content and/or the reply body. Editing the reply goes
// through editReply so approval/history stay consistent.
api.patch(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    const body = req.body as Record<string, unknown>;

    // Review content fields (rare, but the operator owns these).
    if (typeof body.text === "string") review.text = body.text;
    if (typeof body.rating === "number") review.rating = body.rating;
    if (body.author && typeof body.author === "object") {
      const name = (body.author as { name?: unknown }).name;
      if (typeof name === "string") review.author = { name };
    }
    if (typeof body.language === "string") review.language = body.language;

    // Reply edit routes through the pipeline (archives prior, resets approval).
    if (typeof body.reply === "object" && body.reply !== null) {
      const replyBody = (body.reply as { body?: unknown }).body;
      if (typeof replyBody === "string" && replyBody.trim()) {
        await editReply(review, { body: replyBody, by: "operator" });
      }
    }
    await review.save();
    res.json(review);
  }),
);

// Delete a review.
api.delete(
  "/reviews/:id",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await review.deleteOne();
    res.status(204).end();
  }),
);

// Re-run analysis + reply generation.
api.post(
  "/reviews/:id/analyze",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await processReview(review);
    res.json(review);
  }),
);

// Regenerate the reply (operator on behalf of the client).
api.post(
  "/reviews/:id/reply/regenerate",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await regenerateReply(review, { by: "operator" });
    res.json(review);
  }),
);

// Edit the reply body explicitly.
api.patch(
  "/reviews/:id/reply",
  validate({ body: replyUpdateSchema }),
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await editReply(review, { body: req.body.body, by: "operator" });
    res.json(review);
  }),
);

// Approve the reply (operator on behalf of the client).
api.post(
  "/reviews/:id/reply/approve",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await approveReply(review, { by: "operator" });
    res.json(review);
  }),
);

// Mark an approved reply as posted (operator posts manually for MVP).
api.post(
  "/reviews/:id/mark-posted",
  validate({ body: markPostedSchema }),
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await markPosted(review, { by: "operator", note: req.body.note });
    res.json(review);
  }),
);

router.use("/api", api);

export default router;
