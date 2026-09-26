import { z } from "zod"

export const organizationDetailsSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Organization name is required.")
    .max(160, "Organization name must be 160 characters or fewer."),
  slug: z
    .string()
    .min(1, "Organization slug is required.")
    .max(120, "Organization slug must be 120 characters or fewer.")
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Use lowercase letters, numbers, and single hyphens for the organization slug."
    ),
})
