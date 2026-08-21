import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { requireAdminToken } from "../middleware/adminAuth.js";
import { validate } from "../middleware/validate.js";
import {
  projectCreateSchema,
  projectUpdateSchema,
  templateCreateSchema,
  templateUpdateSchema,
} from "../schemas/index.js";
import { Project } from "../models/Project.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { Form } from "../models/Form.js";
import { Email, EMAIL_STATUSES } from "../models/Email.js";
import { generateApiKey } from "../utils/apiKey.js";
import { asyncHandler, badRequest, conflict, notFound } from "../utils/errors.js";

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

// ---- Emails (read-only) ----

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

api.get(
  "/emails/:id",
  asyncHandler(async (req, res) => {
    if (!isValidObjectId(req.params.id)) throw notFound("Email not found");
    const email = await Email.findById(req.params.id);
    if (!email) throw notFound("Email not found");
    res.json(email);
  }),
);

router.use("/api", api);

export default router;
