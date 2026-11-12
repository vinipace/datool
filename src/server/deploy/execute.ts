import Ajv from "ajv"
import { TracerError } from "../tracer/errors"
import {
  agentSandboxSchema,
  type AgentSandboxProvider,
} from "@/src/lib/build/sandbox"
import { deploymentRunner } from "./runner"
import { deploymentCapabilities } from "./capabilities"
import type { BuildContext } from "../build/context"
import { runAgentSandboxCommand } from "../build/sandbox-runtime"
import type { DeploymentTool } from "@/src/lib/deploy/contracts"

// Keep customer-controlled schemas bounded and free of host-executed regex or refs.
export function validateDeploymentSchema(schema: Record<string, unknown>) {
  const allowed = new Set([
    "type",
    "description",
    "title",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "const",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "default",
    "anyOf",
    "oneOf",
    "allOf",
    "$schema",
  ])
  if (Buffer.byteLength(JSON.stringify(schema)) > 32 * 1024)
    throw new Error("Tool schema exceeds 32 KiB.")
  function visit(value: unknown, depth: number) {
    if (
      depth > 12 ||
      !value ||
      typeof value !== "object" ||
      Array.isArray(value)
    )
      throw new Error("Invalid or deeply nested tool schema.")
    for (const [key, child] of Object.entries(value)) {
      if (!allowed.has(key))
        throw new Error(`Unsupported tool schema keyword: ${key}`)
      if (key === "properties") {
        for (const entry of Object.values(child as object))
          visit(entry, depth + 1)
      }
      if (
        ["items", "additionalProperties"].includes(key) &&
        typeof child === "object"
      )
        visit(child, depth + 1)
      if (["anyOf", "oneOf", "allOf"].includes(key)) {
        if (!Array.isArray(child))
          throw new Error("Expected schema alternatives.")
        for (const entry of child) visit(entry, depth + 1)
      }
    }
  }
  visit(schema, 0)
  new Ajv({ strict: false, validateFormats: false }).compile(schema)
}

export function validateToolInput(tool: DeploymentTool, input: unknown) {
  const ajv = new Ajv({
    strict: false,
    allErrors: false,
    validateFormats: false,
  })
  // Remote refs are never loaded. Inputs and schemas are bounded before reaching Ajv.
  const validate = ajv.compile(tool.inputSchema)
  if (!validate(input))
    throw new Error(
      `Invalid input for ${tool.name}: ${ajv.errorsText(validate.errors)}`
    )
}

export async function executeDeploymentModule(
  context: BuildContext,
  options: {
    code: string
    sandbox: AgentSandboxProvider
    mode: "describe" | "tool" | "source" | "schema"
    name?: string
    input?: unknown
    deploymentId?: string
    signal?: AbortSignal
  }
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(90_000),
    ...(options.signal ? [options.signal] : []),
  ])
  const packet =
    JSON.stringify({
      code: options.code,
      mode: options.mode,
      name: options.name,
      input: options.input,
    }) + "\n"
  const command = `node -e '${deploymentRunner.replaceAll("'", "'\\''")}'`
  const result = await runAgentSandboxCommand(
    context,
    agentSandboxSchema.parse({
      enabled: true,
      provider: options.sandbox,
      networkAccess: false,
    }),
    { command, timeoutSeconds: 60 },
    signal,
    {
      stdin: packet,
      maxOutputBytes: 2 * 1024 * 1024,
      rpc: deploymentCapabilities(context, {
        sandbox: options.sandbox,
        deploymentId: options.deploymentId,
        readOnly: options.mode !== "tool",
        signal,
      }),
    }
  )
  if (result.exitCode !== 0 || result.truncated)
    throw new Error(
      "Deployed code failed, timed out or exceeded its output limit."
    )
  const output = JSON.parse(result.stdout)
  if (output.error)
    throw new TracerError("VALIDATION_ERROR", String(output.error), {
      details: { reason: "DEPLOYMENT_MODULE_FAILED" },
    })
  return output.value as unknown
}
