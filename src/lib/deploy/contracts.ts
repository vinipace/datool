import { z } from "zod"

export const deploymentMaxBytes = 4 * 1024 * 1024
export const deploymentName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const deploymentPath = z
  .string()
  .max(240)
  .regex(/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*(\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*)*$/)
export const deploymentConfig = z
  .object({
    sandbox: z.enum(["local", "modal", "boat", "datool"]).optional(),
    storageConnectionId: z.string().uuid().nullable().default(null),
  })
  .strict()
export const deploymentDocument = z
  .object({
    path: deploymentPath,
    title: z.string().min(1).max(200),
    text: z.string().min(1).max(200_000),
  })
  .strict()
export const deploymentBundle = z
  .object({
    version: z.literal(1),
    config: deploymentConfig,
    code: z.string().max(2 * 1024 * 1024),
    database: z
      .object({ code: z.string().max(2 * 1024 * 1024) })
      .strict()
      .optional(),
    tools: z.array(deploymentName).max(64),
    collectors: z.array(deploymentName).max(20),
    agents: z
      .array(
        z
          .object({
            slug: deploymentName,
            instructions: z.string().min(1).max(64_000),
            configuration: z.record(z.string(), z.json()).default({}),
          })
          .strict()
      )
      .max(30),
    skills: z
      .array(
        deploymentDocument.extend({
          title: z.string().min(1).max(160),
          text: z.string().min(1).max(32_000),
        })
      )
      .max(50),
    sources: z.array(deploymentDocument).max(100),
  })
  .strict()
  .superRefine((bundle, context) => {
    for (const [key, names] of Object.entries({
      tools: bundle.tools,
      collectors: bundle.collectors,
      agents: bundle.agents.map((a) => a.slug),
      skills: bundle.skills.map((s) => s.path),
      sources: bundle.sources.map((s) => s.path),
    })) {
      if (new Set(names).size !== names.length)
        context.addIssue({
          code: "custom",
          path: [key],
          message: "Duplicate names are not allowed.",
        })
    }
    if (bundle.tools.includes("brain_search"))
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "brain_search is reserved for company knowledge.",
      })
  })
export type DeploymentBundle = z.infer<typeof deploymentBundle>
export const deploymentTool = z
  .object({
    name: deploymentName,
    description: z.string().min(1).max(2000),
    inputSchema: z
      .record(z.string(), z.json())
      .refine(
        (s) => s.type === "object",
        "Tool inputSchema must describe an object."
      ),
  })
  .strict()
export type DeploymentTool = z.infer<typeof deploymentTool>
export const deployInput = z
  .object({
    bundle: deploymentBundle,
    expectedDeploymentId: z.string().uuid().nullable(),
    planOnly: z.boolean().optional(),
  })
  .strict()
export const brainSearchSchema = z
  .object({
    query: z.string().min(1).max(2000),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict()
export const brainTool: DeploymentTool = {
  name: "brain_search",
  description:
    "Search the project's company knowledge. Results include source paths and excerpts.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", minLength: 1, maxLength: 2000 },
      limit: { type: "integer", minimum: 1, maximum: 20 },
    },
    required: ["query"],
    additionalProperties: false,
  },
}
