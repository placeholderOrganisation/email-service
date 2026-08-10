import rateLimit from "express-rate-limit";
import { tooManyRequests } from "../utils/errors.js";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

/**
 * Limits sends **per API key** (falling back to IP before auth runs), so one busy
 * project can't exhaust the limit for the others. Mount this AFTER requireApiKey.
 * Generous by default — this guards against runaway loops, not normal traffic.
 */
export const sendLimiter = rateLimit({
  windowMs: MINUTE,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.project?._id.toString() ?? req.ip ?? "unknown",
  handler: (_req, _res, next) => next(tooManyRequests("Too many requests, slow down.")),
});

/**
 * Per-IP limit for the PUBLIC form-submit endpoint (no API key). Tight, because
 * anyone can call it — this bounds contact-form spam.
 */
export const formLimiter = rateLimit({
  windowMs: HOUR,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, _res, next) => next(tooManyRequests("Too many submissions, please try again later.")),
});
