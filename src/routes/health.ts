import { Router } from "express";
import mongoose from "mongoose";

const router = Router();

/** Liveness + DB connectivity, for Render's health check. No auth. */
router.get("/", (_req, res) => {
  const dbConnected = mongoose.connection.readyState === 1;
  res.status(dbConnected ? 200 : 503).json({
    ok: dbConnected,
    service: "email-service",
    db: dbConnected ? "connected" : "disconnected",
  });
});

export default router;
