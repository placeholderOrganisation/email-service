import type { NextFunction, Request, Response } from "express";
import { Project, type ProjectDoc } from "../models/Project.js";
import { hashApiKey } from "../utils/apiKey.js";
import { unauthorized } from "../utils/errors.js";

declare global {
  // oxlint-disable-next-line typescript/no-namespace
  namespace Express {
    interface Request {
      project?: ProjectDoc;
    }
  }
}

/**
 * Authenticates a project by its API key (`Authorization: Bearer <key>`). The key
 * is hashed and matched against the stored hash — the plaintext is never stored.
 */
export async function requireApiKey(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : undefined;
  if (!token) {
    next(unauthorized("Missing API key"));
    return;
  }

  const project = await Project.findOne({ apiKeyHash: hashApiKey(token), active: true });
  if (!project) {
    next(unauthorized("Invalid API key"));
    return;
  }

  req.project = project;
  next();
}
