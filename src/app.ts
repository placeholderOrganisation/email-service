import express from "express";
import cors from "cors";
import morgan from "morgan";
import { env } from "./config/env.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import healthRoutes from "./routes/health.js";
import sendRoutes from "./routes/send.js";
import emailRoutes from "./routes/emails.js";
import templateRoutes from "./routes/templates.js";
import formRoutes from "./routes/forms.js";
import adminRoutes from "./routes/admin.js";

export function createApp() {
  const app = express();

  // Behind Render's proxy the client IP comes from X-Forwarded-For. Trust one
  // hop so the rate limiter's IP fallback keys on the real client; off in dev.
  app.set("trust proxy", env.nodeEnv === "production" ? 1 : false);

  app.use(
    cors({
      origin: env.clientOrigins.includes("*") ? true : env.clientOrigins,
    }),
  );
  // Cap payload size — emails are small; this bounds abuse.
  app.use(express.json({ limit: "256kb" }));
  // Log method/status/timing only — never request bodies (recipients + content are PII).
  if (env.nodeEnv !== "test") app.use(morgan("dev"));

  app.use("/health", healthRoutes);
  app.use("/v1/send", sendRoutes);
  app.use("/v1/emails", emailRoutes);
  app.use("/v1/templates", templateRoutes);
  app.use("/v1/forms", formRoutes); // public (no API key) — see routes/forms.ts
  app.use("/admin", adminRoutes); // dashboard UI + its token-gated JSON API

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
