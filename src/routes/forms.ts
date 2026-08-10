import { Router } from "express";
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
    const form = await Form.findOne({ formId: req.params.formId, active: true });
    if (!form) throw notFound("Form not found");

    // Origin allowlist (defense-in-depth alongside CORS). Empty list = allow any.
    if (form.allowedOrigins.length > 0) {
      const origin = req.get("origin");
      const allowed = form.allowedOrigins.map(normalizeOrigin);
      if (!origin || !allowed.includes(normalizeOrigin(origin))) {
        throw forbidden("Origin not allowed for this form");
      }
    }

    const body = req.body as FormSubmitInput;

    // Honeypot: a bot filled the hidden field. Pretend success and drop silently.
    if (body._gotcha && body._gotcha.trim() !== "") {
      res.json({ ok: true });
      return;
    }

    const project = await Project.findById(form.projectId);
    if (!project) throw badRequest("Form is misconfigured (missing project)");

    const variables = {
      ...(body.fields ?? {}),
      name: body.name,
      email: body.email,
      message: body.message,
      submittedAt: new Date().toLocaleString(),
    };

    // Notify the owner. From is the project's verified sender; replies go to the
    // submitter via Reply-To.
    await enqueueEmail({
      projectId: form.projectId,
      to: form.toAddress,
      from: formatFrom(project),
      replyTo: body.email,
      templateName: form.notifyTemplate,
      variables,
    });

    // Optional acknowledgment to the submitter (only if the form enables it).
    if (form.ackTemplate) {
      await enqueueEmail({
        projectId: form.projectId,
        to: body.email,
        from: formatFrom(project),
        templateName: form.ackTemplate,
        variables,
      });
    }

    res.json({ ok: true });
  }),
);

export default router;
