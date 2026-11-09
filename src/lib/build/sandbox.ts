import { z } from "zod"

export const agentSandboxProviderSchema = z.enum(["datool", "local", "modal"])
export type AgentSandboxProvider = z.infer<typeof agentSandboxProviderSchema>

// A dedicated namespace keeps mounts away from system directories and credentials.
export const sandboxPathSchema = z
  .string()
  .max(240)
  .regex(
    /^\/workspace(?:\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/,
    "Use /workspace or a directory within it, without spaces or parent segments."
  )

export const agentSandboxSchema = z
  .object({
    enabled: z.boolean().default(false),
    provider: agentSandboxProviderSchema.default("datool"),
    environment: z.enum(["node", "python"]).default("node"),
    networkAccess: z.boolean().default(false),
    workingDirectory: sandboxPathSchema.default("/workspace"),
    drives: z
      .array(
        z
          .object({
            driveId: z.string().uuid(),
            mountPath: sandboxPathSchema,
          })
          .strict()
      )
      .max(4)
      .default([]),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (let i = 0; i < value.drives.length; i++) {
      const mount = value.drives[i]
      if (
        value.drives
          .slice(0, i)
          .some(
            (other) =>
              other.driveId === mount.driveId ||
              other.mountPath === mount.mountPath ||
              other.mountPath.startsWith(`${mount.mountPath}/`) ||
              mount.mountPath.startsWith(`${other.mountPath}/`)
          )
      )
        ctx.addIssue({
          code: "custom",
          path: ["drives", i],
          message: "Each drive needs a unique, non-overlapping mount path.",
        })
    }
  })
export type AgentSandboxConfiguration = z.infer<typeof agentSandboxSchema>

export const createDriveSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  provider: agentSandboxProviderSchema,
})
export type AgentDrive = z.infer<typeof createDriveSchema> & {
  id: string
  createdAt: string
}

export const sandboxCommandSchema = z
  .object({
    command: z.string().min(1).max(32_000),
    timeoutSeconds: z.number().int().min(1).max(60).default(30),
  })
  .strict()
export type SandboxCommandResult = {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}
