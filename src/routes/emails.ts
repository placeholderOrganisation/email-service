import { Router } from "express";
import { isValidObjectId } from "mongoose";
import { requireApiKey } from "../middleware/auth.js";
import { Email } from "../models/Email.js";
import { asyncHandler, notFound } from "../utils/errors.js";

const router = Router();

/** Returns the status of one email — scoped to the caller's project. */
router.get(
  "/:id",
  requireApiKey,
  asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!isValidObjectId(id)) throw notFound("Email not found");

    const email = await Email.findOne({ _id: id, projectId: req.project!._id });
    if (!email) throw notFound("Email not found");

    res.json(email);
  }),
);

export default router;
