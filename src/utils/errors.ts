import type { NextFunction, Request, Response } from "express";

export class AppError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    Object.setPrototypeOf(this, AppError.prototype);
  }
}

export const notFound = (msg = "Not found") => new AppError(404, msg);
export const badRequest = (msg = "Bad request", details?: unknown) => new AppError(400, msg, details);
export const unauthorized = (msg = "Unauthorized") => new AppError(401, msg);
export const forbidden = (msg = "Forbidden") => new AppError(403, msg);
export const conflict = (msg = "Conflict") => new AppError(409, msg);
export const tooManyRequests = (msg = "Too many requests") => new AppError(429, msg);

/** Wraps an async route handler so thrown/rejected errors reach the error middleware. */
export function asyncHandler<
  T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
>(fn: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
}
