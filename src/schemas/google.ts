import { z } from "zod";

/**
 * Link a project to a Business Profile location (operator only), or — with just
 * { syncEnabled } — toggle scheduled sync on an already-linked project.
 */
export const projectGoogleLinkSchema = z
  .object({
    accountName: z.string().trim().regex(/^accounts\/[^/\s]+$/, 'Must look like "accounts/{id}"').optional(),
    locationName: z.string().trim().regex(/^locations\/[^/\s]+$/, 'Must look like "locations/{id}"').optional(),
    locationTitle: z.string().trim().max(300).optional(),
    placeId: z.string().trim().max(300).optional(),
    syncEnabled: z.boolean().optional(),
  })
  .superRefine((d, ctx) => {
    const linking = d.accountName !== undefined || d.locationName !== undefined;
    if (linking && (!d.accountName || !d.locationName)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "accountName and locationName are both required to link" });
    }
    if (!linking && d.syncEnabled === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Provide { accountName, locationName, syncEnabled } to link, or { syncEnabled } to toggle sync",
      });
    }
  });

export type ProjectGoogleLinkInput = z.infer<typeof projectGoogleLinkSchema>;
