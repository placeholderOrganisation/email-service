import type { NextFunction, Request, Response } from "express";
import { env } from "../config/env.js";
import { AppError } from "../utils/errors.js";

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // next is required for Express to treat this as an error handler
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    if (env.nodeEnv !== "test") {
      console.warn(`[api] ${req.method} ${req.originalUrl} ${err.status} ${err.message}`);
    }
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }

  // Mongo duplicate key
  if (typeof err === "object" && err !== null && (err as { code?: number }).code === 11000) {
    res.status(409).json({ error: "Duplicate key", details: (err as { keyValue?: unknown }).keyValue });
    return;
  }

  console.error("[error]", err);
  res.status(500).json({ error: "Internal server error" });
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "Route not found" });
}
