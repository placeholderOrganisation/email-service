import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { unauthorized } from "../utils/errors.js";

/** Constant-time string compare so token checks don't leak timing info. */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Guards the admin dashboard's JSON API with a single shared secret (`ADMIN_TOKEN`).
 * There's only one operator (you), so a bearer-style shared secret is enough —
 * no need for a user/session system. Sent as `X-Admin-Token` (the browser page
 * stores it in localStorage and attaches it to each fetch).
 */
export function requireAdminToken(req: Request, _res: Response, next: NextFunction): void {
  // No token configured → the admin UI is open (useful for local dev). Set
  // ADMIN_TOKEN in any environment where the dashboard must be protected.
  if (!env.adminToken) {
    next();
    return;
  }
  const provided = req.get("X-Admin-Token") ?? "";
  if (!provided || !safeEqual(provided, env.adminToken)) {
    next(unauthorized("Invalid admin token"));
    return;
  }
  next();
}
