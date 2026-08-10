import { Router } from "express";
import { requireApiKey } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import {
  templateCreateSchema,
  templateParamsSchema,
  templateUpdateSchema,
} from "../schemas/index.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { asyncHandler, conflict, notFound } from "../utils/errors.js";

const router = Router();

router.use(requireApiKey);

/** List this project's templates. */
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const templates = await EmailTemplate.find({ projectId: req.project!._id }).sort({ name: 1 });
    res.json(templates);
  }),
);

/** Create a template. */
router.post(
  "/",
  validate({ body: templateCreateSchema }),
  asyncHandler(async (req, res) => {
    const projectId = req.project!._id;
    const exists = await EmailTemplate.exists({ projectId, name: req.body.name });
    if (exists) throw conflict(`Template "${req.body.name}" already exists`);

    const template = await EmailTemplate.create({ projectId, ...req.body });
    res.status(201).json(template);
  }),
);

/** Get one template by name. */
router.get(
  "/:name",
  validate({ params: templateParamsSchema }),
  asyncHandler(async (req, res) => {
    const template = await EmailTemplate.findOne({
      projectId: req.project!._id,
      name: req.params.name,
    });
    if (!template) throw notFound("Template not found");
    res.json(template);
  }),
);

/** Update a template's subject/format/body. */
router.put(
  "/:name",
  validate({ params: templateParamsSchema, body: templateUpdateSchema }),
  asyncHandler(async (req, res) => {
    const template = await EmailTemplate.findOneAndUpdate(
      { projectId: req.project!._id, name: req.params.name },
      { $set: req.body },
      { new: true },
    );
    if (!template) throw notFound("Template not found");
    res.json(template);
  }),
);

/** Delete a template. */
router.delete(
  "/:name",
  validate({ params: templateParamsSchema }),
  asyncHandler(async (req, res) => {
    const result = await EmailTemplate.deleteOne({
      projectId: req.project!._id,
      name: req.params.name,
    });
    if (result.deletedCount === 0) throw notFound("Template not found");
    res.status(204).end();
  }),
);

export default router;
