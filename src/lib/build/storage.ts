import { z } from "zod"

export const storageProviderSchema = z.enum([
  "local",
  "datool",
  "modal",
  "s3",
  "gcs",
])
export const storageProviderNames = {
  local: "Local volume",
  datool: "Datool volume",
  modal: "Modal volume",
  s3: "S3-compatible storage",
  gcs: "Google Cloud Storage",
} as const
const location = {
  bucket: z
    .string()
    .trim()
    .min(3)
    .max(222)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]+$/),
  prefix: z
    .string()
    .trim()
    .max(200)
    .regex(/^(?:[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/)*[a-zA-Z0-9_.-]*$/)
    .default("datool"),
}
export const storageConfigSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("s3"),
      ...location,
      region: z.string().trim().min(1).max(80),
      endpoint: z.url().max(1000).optional(),
    })
    .strict(),
  z
    .object({
      provider: z.literal("gcs"),
      ...location,
      projectId: z.string().trim().min(1).max(200),
    })
    .strict(),
])
export type StorageConfig = z.infer<typeof storageConfigSchema>
export const storageConnectionInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRevision: z.number().int().positive().optional(),
    name: z.string().trim().min(1).max(120),
    config: storageConfigSchema,
    credentials: z.record(z.string(), z.string().max(16000)).optional(),
  })
  .strict()
export const storageConnectionSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  config: storageConfigSchema,
  revision: z.number(),
  createdAt: z.string(),
})
export type StorageConnection = z.infer<typeof storageConnectionSchema>
export type StorageConnectionInput = z.infer<
  typeof storageConnectionInputSchema
>

export const driveVersionSchema = z.object({
  id: z.uuid(),
  createdAt: z.string(),
  files: z.number(),
  bytes: z.number(),
  current: z.boolean(),
})
export const cloudStorage = (provider: string) =>
  provider === "s3" || provider === "gcs"
