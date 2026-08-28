import { Router } from "express";
import { env } from "../config/env.js";
import { formLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { formSubmitSchema, type FormSubmitInput } from "../schemas/index.js";
import { Form } from "../models/Form.js";
import { Project } from "../models/Project.js";
import { enqueueEmail } from "../services/enqueue.js";
import { formatFrom } from "../utils/sender.js";
import { asyncHandler, badRequest, forbidden, notFound } from "../utils/errors.js";

const router = Router();

const normalizeOrigin = (o: string) => o.trim().replace(/\/+$/, "").toLowerCase();

/** Vite / local frontends. Browsers set Origin; other public sites cannot spoof this. */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return false;
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}

/** Empty allowlist = any origin. Loopback is always accepted so local dev works. */
function isOriginAllowed(origin: string | undefined, allowedOrigins: string[]): boolean {
  if (allowedOrigins.length === 0) return true;
  if (!origin) return false;
  if (isLoopbackOrigin(origin)) return true;
  return allowedOrigins.map(normalizeOrigin).includes(normalizeOrigin(origin));
}

/** Request-scoped form logs. Skipped in tests; never includes body/PII. */
function formLog(level: "log" | "warn", message: string, extra: Record<string, unknown> = {}): void {
  if (env.nodeEnv === "test") return;
  const fields = Object.entries(extra)
    .map(([k, v]) => `${k}=${v === undefined || v === "" ? "(none)" : JSON.stringify(v)}`)
    .join(" ");
  console[level](`[forms] ${message}${fields ? ` ${fields}` : ""}`);
}

/**
 * PUBLIC form submission — no API key. Safe for a static site to call because the
 * `formId` can only submit this one form to its fixed `toAddress`/templates.
 * Guarded by: per-IP rate limit, an origin allowlist, and a honeypot field.
 */
router.post(
  "/:formId/submit",
  formLimiter,
  validate({ body: formSubmitSchema }),
  asyncHandler(async (req, res) => {
    const formId = req.params.formId;
    const origin = req.get("origin");
    formLog("log", "submit", {
      formId,
      origin,
      referer: req.get("referer"),
      ip: req.ip,
    });

    const form = await Form.findOne({ formId, active: true });
    if (!form) {
      formLog("warn", "rejected", { formId, reason: "form not found or inactive" });
      throw notFound("Form not found");
    }

    // Origin allowlist (defense-in-depth alongside CORS). Empty list = allow any.
    // localhost / 127.0.0.1 / ::1 are always accepted so a local frontend can
    // submit without adding those origins to the production form.
    if (!isOriginAllowed(origin, form.allowedOrigins)) {
      formLog("warn", "rejected", {
        formId,
        reason: "origin not allowed",
        origin,
        allowed: form.allowedOrigins.map(normalizeOrigin),
      });
      throw forbidden("Origin not allowed for this form");
    }

    const body = req.body as FormSubmitInput;

    // Honeypot: a bot filled the hidden field. Pretend success and drop silently.
    if (body._gotcha && body._gotcha.trim() !== "") {
      formLog("warn", "dropped honeypot", { formId });
      res.json({ ok: true });
      return;
    }

    const project = await Project.findById(form.projectId);
    if (!project) {
      formLog("warn", "rejected", { formId, reason: "missing project" });
      throw badRequest("Form is misconfigured (missing project)");
    }

    const variables = {
      ...(body.fields ?? {}),
      name: body.name,
      email: body.email,
      message: body.message,
      submittedAt: new Date().toLocaleString(),
    };

    // Notify the owner. From is the project's verified sender; replies go to the
    // submitter via Reply-To.
    const notify = await enqueueEmail({
      projectId: form.projectId,
      to: form.toAddress,
      from: formatFrom(project),
      replyTo: body.email,
      templateName: form.notifyTemplate,
      variables,
    });

    // Optional acknowledgment to the submitter (only if the form enables it).
    let ackId: string | undefined;
    if (form.ackTemplate) {
      const ack = await enqueueEmail({
        projectId: form.projectId,
        to: body.email,
        from: formatFrom(project),
        templateName: form.ackTemplate,
        variables,
      });
      ackId = String(ack._id);
    }

    formLog("log", "enqueued", {
      formId,
      notifyId: String(notify._id),
      ackId: ackId ?? "(none)",
    });

    res.json({ ok: true });
  }),
);

export default router;
