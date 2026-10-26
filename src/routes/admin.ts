import path from "node:path";
import { fileURLToPath } from "node:url";
import { Router, type Response } from "express";
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
  projectGoogleLinkSchema,
  toReviewList,
  type ProjectGoogleLinkInput,
} from "../schemas/index.js";
import { isGoogleConfigured } from "../config/env.js";
import { Project, type ProjectDocument } from "../models/Project.js";
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
  publishReplyToGoogle,
} from "../services/reviewPipeline.js";
import { BUSINESS_MANAGE_SCOPE, getGoogleClient, type GoogleLocation } from "../services/google/client.js";
import {
  consumeOAuthState,
  createOAuthState,
  disconnectGoogle,
  getGoogleStatus,
  isGoogleConnected,
  storeGoogleConnection,
} from "../services/google/connection.js";
import { toGoogleAppError } from "../services/google/errors.js";
import { acquireSyncLock, isSyncRunning, runLockedSync } from "../services/google/sync.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const router = Router();

// The dashboard shell is a static file with no secrets baked in — it prompts
// for the admin token client-side and attaches it to each API call below. So
// this one route is intentionally unauthenticated (like a login page).
router.get(["/", ""], (_req, res) => {
  res.sendFile(path.join(__dirname, "../../public/admin/index.html"));
});

// ---- Google OAuth callback (browser redirect from Google) ----

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** A tiny plain error page — never includes tokens, codes, or the state. */
function callbackPage(res: Response, status: number, message: string): void {
  res
    .status(status)
    .type("html")
    .send(
      `<!doctype html><meta charset="utf-8"><title>Google connection</title>` +
        `<body style="font:15px/1.5 -apple-system,sans-serif;max-width:560px;margin:60px auto;padding:0 20px">` +
        `<h2>Google connection failed</h2><p>${escapeHtml(message)}</p>` +
        `<p><a href="/admin">Back to the dashboard</a></p></body>`,
    );
}

// Unauthenticated by necessity (no X-Admin-Token on a redirect): it is
// authenticated SOLELY by the single-use, unexpired OAuth state minted by the
// token-gated POST /api/google/connect.
router.get("/google/callback", async (req, res) => {
  res.set("Cache-Control", "no-store");
  const q = (k: string) => (typeof req.query[k] === "string" ? (req.query[k] as string) : undefined);
  try {
    if (!isGoogleConfigured()) {
      callbackPage(res, 400, "Google integration is not configured on this server.");
      return;
    }
    if (!(await consumeOAuthState(q("state")))) {
      callbackPage(res, 400, "This sign-in link is invalid, expired, or already used. Go back to the dashboard and click Connect Google again.");
      return;
    }
    const oauthError = q("error");
    if (oauthError) {
      callbackPage(res, 400, `Google did not grant access (${oauthError}). Click Connect Google in the dashboard to try again.`);
      return;
    }
    const code = q("code");
    if (!code) {
      callbackPage(res, 400, "Google did not return an authorization code. Try connecting again.");
      return;
    }

    let tokens;
    try {
      tokens = await getGoogleClient().exchangeCode(code);
    } catch (err) {
      callbackPage(res, 502, `Could not complete Google sign-in: ${err instanceof Error ? err.message : "unknown error"}`);
      return;
    }
    if (!tokens.refreshToken) {
      callbackPage(
        res,
        400,
        "Google did not return a refresh token, so the service could not stay connected. This happens when the app " +
          "was already authorized. Remove this app's access at https://myaccount.google.com/permissions, then click " +
          "Connect Google again.",
      );
      return;
    }
    if (tokens.scopes.length && !tokens.scopes.includes(BUSINESS_MANAGE_SCOPE)) {
      callbackPage(res, 400, "Business Profile access was not granted. Connect again and allow managing your Business Profile.");
      return;
    }
    await storeGoogleConnection({ refreshToken: tokens.refreshToken, email: tokens.email, scopes: tokens.scopes });
    res.redirect(302, "/admin");
  } catch (err) {
    console.error("[google] callback failed", err instanceof Error ? err.message : err);
    callbackPage(res, 500, "Something went wrong while saving the Google connection. Try again.");
  }
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
    const projectMapped = Boolean(project.google?.locationName);
    res.json(
      reviews.map((review) => {
        const json = review.toJSON() as Record<string, unknown>;
        json.projectName = project.name;
        json.googleLinked = projectMapped && Boolean(review.google?.reviewName);
        return json;
      }),
    );
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
      .populate("projectId", "name google.locationName");
    const out = reviews.map((review) => {
      const json = review.toJSON() as Record<string, unknown>;
      const proj = review.projectId as unknown as {
        _id: Types.ObjectId;
        name?: string;
        google?: { locationName?: string };
      } | null;
      let projectMapped = false;
      if (proj && typeof proj === "object" && "name" in proj) {
        json.projectId = proj._id;
        json.projectName = proj.name;
        projectMapped = Boolean(proj.google?.locationName);
      }
      // "Post to Google" is possible only for API-synced reviews in a linked project.
      json.googleLinked = projectMapped && Boolean(review.google?.reviewName);
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

// Mark an approved reply as posted (operator posted it by hand). Pure
// record-keeping — the manual fallback; never calls Google.
api.post(
  "/reviews/:id/mark-posted",
  validate({ body: markPostedSchema }),
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await markPosted(review, { by: "operator", note: req.body.note });
    res.json(review);
  }),
);

// "Post to Google": publish the approved reply via the Business Profile API.
api.post(
  "/reviews/:id/publish",
  asyncHandler(async (req, res) => {
    const review = await loadReview(req.params.id);
    await publishReplyToGoogle(review, { by: "operator" });
    res.json(review);
  }),
);

// ---- Google Business Profile (operator) ----

function requireGoogleConfigured(): void {
  if (!isGoogleConfigured()) {
    throw badRequest(
      "Google integration is not configured: set GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, " +
        "GOOGLE_OAUTH_REDIRECT_URI and GOOGLE_TOKEN_ENCRYPTION_KEY",
    );
  }
}

async function requireGoogleConnected(): Promise<void> {
  requireGoogleConfigured();
  if (!(await isGoogleConnected())) throw conflict("Google is not connected - connect it in the dashboard");
}

/** Operator view of a project's Google link + sync state. */
function projectGoogleView(project: ProjectDocument) {
  const g = project.google;
  return {
    linked: Boolean(g?.locationName),
    accountName: g?.accountName ?? null,
    locationName: g?.locationName ?? null,
    locationTitle: g?.locationTitle ?? null,
    placeId: g?.placeId ?? null,
    syncEnabled: Boolean(g?.syncEnabled),
    running: isSyncRunning(project),
    lastSyncStatus: g?.lastSyncStatus ?? "idle",
    lastSyncedAt: g?.lastSyncedAt ?? null,
    lastSyncError: g?.lastSyncError ?? null,
    lastSyncStats: g?.lastSyncStats ?? null,
  };
}

function formatAddress(a: GoogleLocation["storefrontAddress"]): string {
  if (!a) return "";
  return [...(a.addressLines ?? []), a.locality, a.administrativeArea, a.postalCode].filter(Boolean).join(", ");
}

api.get(
  "/google/status",
  asyncHandler(async (_req, res) => {
    res.json(await getGoogleStatus());
  }),
);

// Starts the OAuth flow: mints a single-use state and returns Google's consent URL.
api.post(
  "/google/connect",
  asyncHandler(async (_req, res) => {
    requireGoogleConfigured();
    const state = await createOAuthState();
    res.json({ url: getGoogleClient().getAuthUrl(state) });
  }),
);

api.post(
  "/google/disconnect",
  asyncHandler(async (_req, res) => {
    const { revoked } = await disconnectGoogle();
    res.json({ connected: false, revoked });
  }),
);

// Every location the connected account can manage, flattened across accounts.
api.get(
  "/google/locations",
  asyncHandler(async (_req, res) => {
    await requireGoogleConnected();
    const client = getGoogleClient();
    const rows: {
      accountName: string;
      accountDisplayName: string;
      locationName: string;
      title: string;
      address: string;
      placeId: string | null;
      linkedProjectId: string | null;
      linkedProjectName: string | null;
    }[] = [];
    try {
      for (const account of await client.listAccounts()) {
        for (const loc of await client.listLocations(account.name)) {
          rows.push({
            accountName: account.name,
            accountDisplayName: account.accountName ?? account.name,
            locationName: loc.name,
            title: loc.title ?? loc.name,
            address: formatAddress(loc.storefrontAddress),
            placeId: loc.metadata?.placeId ?? null,
            linkedProjectId: null,
            linkedProjectName: null,
          });
        }
      }
    } catch (err) {
      throw toGoogleAppError(err);
    }
    const linked = await Project.find({ "google.locationName": { $in: rows.map((r) => r.locationName) } }).select(
      "name google.locationName",
    );
    const byLocation = new Map(linked.map((p) => [p.google?.locationName, p]));
    for (const row of rows) {
      const p = byLocation.get(row.locationName);
      if (p) {
        row.linkedProjectId = String(p._id);
        row.linkedProjectName = p.name;
      }
    }
    res.json(rows);
  }),
);

// Link a project to a location (or just toggle syncEnabled on a linked project).
api.put(
  "/projects/:id/google",
  validate({ body: projectGoogleLinkSchema }),
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    const body = req.body as ProjectGoogleLinkInput;

    if (body.accountName && body.locationName) {
      if (isSyncRunning(project)) throw conflict("A sync is running for this project; try again when it finishes");
      const other = await Project.findOne({ _id: { $ne: project._id }, "google.locationName": body.locationName })
        .select("name");
      if (other) throw conflict(`That Google location is already linked to project "${other.name}"`);

      const relinking = project.google?.locationName !== body.locationName;
      project.set("google.accountName", body.accountName);
      project.set("google.locationName", body.locationName);
      project.set("google.locationTitle", body.locationTitle);
      project.set("google.placeId", body.placeId);
      if (body.syncEnabled !== undefined) project.set("google.syncEnabled", body.syncEnabled);
      if (relinking) {
        // A new location needs a full first sync.
        project.set("google.lastSyncedAt", undefined);
        project.set("google.lastSyncStatus", "idle");
        project.set("google.lastSyncError", undefined);
        project.set("google.lastSyncStats", undefined);
      }
    } else {
      if (body.syncEnabled && !project.google?.locationName) {
        throw conflict("Link a Google location before enabling sync");
      }
      project.set("google.syncEnabled", Boolean(body.syncEnabled));
    }
    await project.save(); // a concurrent duplicate link hits the unique index → 409
    res.json(projectGoogleView(project));
  }),
);

api.delete(
  "/projects/:id/google",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    if (isSyncRunning(project)) throw conflict("A sync is running for this project; try again when it finishes");
    for (const key of ["accountName", "locationName", "locationTitle", "placeId", "lastSyncedAt", "lastSyncError", "lastSyncStats"]) {
      project.set(`google.${key}`, undefined);
    }
    project.set("google.syncEnabled", false);
    project.set("google.lastSyncStatus", "idle");
    await project.save();
    res.json(projectGoogleView(project));
  }),
);

// "Sync now": take the lock synchronously (so a concurrent run is a clean 409),
// then run the sync in the background and return 202 immediately.
api.post(
  "/projects/:id/google/sync",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    if (!project.google?.locationName) throw conflict("Project is not linked to a Google location");
    await requireGoogleConnected();
    const lock = await acquireSyncLock(project._id);
    if (!lock.ok) {
      throw conflict(lock.reason === "locked" ? "A sync is already running" : "Project is not linked to a Google location");
    }
    void runLockedSync(lock.project, lock.lockedAt).catch((err) => {
      console.error("[review-sync] background sync failed", err instanceof Error ? err.message : err);
    });
    res.status(202).json(projectGoogleView(lock.project));
  }),
);

api.get(
  "/projects/:id/google/sync",
  asyncHandler(async (req, res) => {
    const project = await loadProject(req.params.id);
    res.json(projectGoogleView(project));
  }),
);

router.use("/api", api);

export default router;
