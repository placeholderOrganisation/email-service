import { z } from "zod";

// Variable values are substituted into subject/body. Keep them scalar.
const variablesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

/**
 * Send payload. Two mutually exclusive shapes:
 *  - Template: { to, templateName, variables? }
 *  - Raw:      { to, subject, one of html/markdown/text }
 * Unknown keys (e.g. a caller-supplied `from`) are stripped and ignored — the
 * sender is always the project's own address.
 */
export const sendSchema = z
  .object({
    to: z.string().email(),
    replyTo: z.string().email().optional(),
    subject: z.string().min(1).max(255).optional(),
    html: z.string().optional(),
    markdown: z.string().optional(),
    text: z.string().optional(),
    templateName: z.string().min(1).optional(),
    variables: variablesSchema.optional(),
  })
  .superRefine((d, ctx) => {
    const hasTemplate = Boolean(d.templateName);
    const hasInline = Boolean(d.html || d.markdown || d.text);
    if (hasTemplate) {
      if (hasInline) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Do not send inline content (html/markdown/text) together with templateName",
        });
      }
      return;
    }
    // Raw mode requires a subject and exactly one content field.
    if (!hasInline) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide templateName, or one of html/markdown/text",
      });
    }
    if (!d.subject) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["subject"],
        message: "subject is required for raw sends",
      });
    }
  });

export type SendInput = z.infer<typeof sendSchema>;

// --- Templates ---

const templateName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, "Use letters, numbers, dot, dash or underscore");

export const templateCreateSchema = z.object({
  name: templateName,
  subject: z.string().min(1).max(255),
  format: z.enum(["html", "markdown"]),
  body: z.string().min(1),
});

export const templateUpdateSchema = z
  .object({
    subject: z.string().min(1).max(255).optional(),
    format: z.enum(["html", "markdown"]).optional(),
    body: z.string().min(1).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update" });

export const templateParamsSchema = z.object({ name: templateName });

export type TemplateCreateInput = z.infer<typeof templateCreateSchema>;
export type TemplateUpdateInput = z.infer<typeof templateUpdateSchema>;

// --- Projects (admin) ---

export const projectCreateSchema = z.object({
  name: z.string().trim().min(1).max(100),
  fromAddress: z.string().email(),
  fromName: z.string().trim().max(100).optional(),
});

export const projectUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    fromAddress: z.string().email().optional(),
    fromName: z.string().trim().max(100).optional(),
    active: z.boolean().optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "Provide at least one field to update" });

export type ProjectCreateInput = z.infer<typeof projectCreateSchema>;
export type ProjectUpdateInput = z.infer<typeof projectUpdateSchema>;

// --- Public form submission ---

/**
 * A form submission from a browser. `name`/`email`/`message` are core; `fields`
 * carries any extra inputs (project type, budget, …) which become template
 * variables. `_gotcha` is the honeypot — real users leave it empty.
 */
export const formSubmitSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.string().email(),
  message: z.string().trim().min(1).max(5000),
  fields: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  _gotcha: z.string().optional(),
});

export type FormSubmitInput = z.infer<typeof formSubmitSchema>;
