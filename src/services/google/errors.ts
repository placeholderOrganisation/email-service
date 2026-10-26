import { AppError } from "../../utils/errors.js";
import { GoogleApiError } from "./client.js";

/**
 * Maps a GoogleApiError onto a clean HTTP error: connection problems are 409
 * (the operator must (re)connect), anything Google refused or failed is 502
 * with Google's own message. Non-Google errors pass through unchanged.
 */
export function toGoogleAppError(err: unknown, prefix = "Google error: "): unknown {
  if (!(err instanceof GoogleApiError)) return err;
  if (err.kind === "not_connected") return new AppError(409, "Google is not connected - connect it in the dashboard");
  if (err.kind === "reconnect") return new AppError(409, `Google connection must be reconnected: ${err.message}`);
  return new AppError(502, `${prefix}${err.message}`);
}
