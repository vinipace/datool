import { z } from "zod"

export type SdkDriveContext = {
  agentId: string
  connectionId: string
  workspace: string
  workspaceName: string
}

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
export type SdkTaskContext = Omit<SavedSdkTaskContext, "scopeKey">
