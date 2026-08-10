import type { NextFunction, Request, Response } from "express";
import { ZodError, type ZodTypeAny, type infer as ZodInfer } from "zod";
import { badRequest } from "../utils/errors.js";

type Schemas = {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
};

/**
 * Validates request parts against Zod schemas and replaces req[part] with the
 * parsed (typed, coerced) value. Zod is the single source of truth for shapes.
 */
export function validate(schemas: Schemas) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) Object.assign(req.query as object, schemas.query.parse(req.query));
      if (schemas.params) Object.assign(req.params as object, schemas.params.parse(req.params));
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(badRequest("Validation failed", err.flatten()));
      } else {
        next(err);
      }
    }
  };
}

export type Infer<T extends ZodTypeAny> = ZodInfer<T>;
