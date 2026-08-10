import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { sendLimiter } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import { sendSchema, type SendInput } from "../schemas/index.js";
import { Email } from "../models/Email.js";
import { enqueueEmail } from "../services/enqueue.js";
import { formatFrom } from "../utils/sender.js";
import { asyncHandler } from "../utils/errors.js";

const router = Router();

/**
 * Enqueues an email. Returns 202 immediately; the worker sends it. The sender is
 * the project's own address — any `from` in the body was already stripped by the
 * schema. An optional `Idempotency-Key` header makes retries safe.
 */
router.post(
  "/",
  requireApiKey,
  sendLimiter,
  validate({ body: sendSchema }),
  asyncHandler(async (req, res) => {
    const project = req.project!;
    const body = req.body as SendInput;
    const idempotencyKey = req.get("Idempotency-Key")?.trim() || undefined;

    // Idempotency: if this key was already used by this project, return the
    // existing email instead of enqueuing a duplicate.
    if (idempotencyKey) {
      const existing = await Email.findOne({ projectId: project._id, idempotencyKey });
      if (existing) {
        res.status(202).json({ id: existing._id, status: existing.status });
        return;
      }
    }

    try {
      const email = await enqueueEmail({
        projectId: project._id,
        to: body.to,
        from: formatFrom(project),
        replyTo: body.replyTo,
        subject: body.subject,
        html: body.html,
        markdown: body.markdown,
        text: body.text,
        templateName: body.templateName,
        variables: body.variables,
        idempotencyKey,
      });
      res.status(202).json({ id: email._id, status: email.status });
    } catch (err) {
      // A concurrent request with the same Idempotency-Key won the unique index —
      // return the row it created rather than erroring.
      if (idempotencyKey && (err as { code?: number }).code === 11000) {
        const existing = await Email.findOne({ projectId: project._id, idempotencyKey });
        if (existing) {
          res.status(202).json({ id: existing._id, status: existing.status });
          return;
        }
      }
      throw err;
    }
  }),
);

export default router;
