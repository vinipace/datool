import { z } from "zod"

export const sdkDriveContextSchema = z.object({
  agentId: z.string(),
  connectionId: z.string().uuid(),
  workspace: z.string(),
  workspaceName: z.string(),
})
export type SdkDriveContext = z.infer<typeof sdkDriveContextSchema>

// Authenticated server state, never accepted from task authoring inputs.
export const savedSdkTaskContextSchema = z
  .object({
    connectionId: z.string().uuid(),
    conversationId: z.string().min(1),
    scopeKey: z.string().min(1),
    driveId: z.string().uuid().nullable(),
    workspace: z.string().nullable(),
    workspaceName: z.string().nullable(),
  })
  .strict()
export type SavedSdkTaskContext = z.infer<typeof savedSdkTaskContextSchema>
export const sdkTaskContextSchema = savedSdkTaskContextSchema.omit({
  scopeKey: true,
})
export type SdkTaskContext = z.infer<typeof sdkTaskContextSchema>
