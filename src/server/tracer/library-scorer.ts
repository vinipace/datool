import { spawn } from "node:child_process"
import { DATOOL_PROVIDER } from "@/src/lib/execution-credits"
import { join } from "node:path"
import { z } from "zod"
import type { ScorerInput } from "@/src/lib/tracer/scorers"
import { scorerInputSchema } from "@/src/lib/tracer/scorers"
import { libraryEvaluator } from "@/src/lib/tracer/scorer-libraries"
import type {
  DatasetItemForEvaluation,
  EvaluatorRunResult,
  JsonObject,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"
import { priceLlmWithCatalog } from "@/src/lib/tracer/pricing"
import { PricingCatalog } from "@/src/lib/tracer/pricing-catalog"
import { resolveNodeBinary } from "../sandbox/evaluator"
import { assertJudgeConfigured, type JudgeOptions } from "./llm-scorer"
import {
  diagnosticResult,
  judgeTransport,
  ProviderExecutionError,
} from "./runtime-diagnostics"

const MAX_BYTES = 256 * 1024
const scoreSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(1).nullable(),
  metadata: z.record(z.string(), z.json()).optional(),
  error: z.unknown().optional(),
})
const requestSchema = z.object({
  type: z.literal("request"),
  id: z.number().int().positive(),
  endpoint: z.enum(["chat/completions", "responses"]),
  body: z.record(z.string(), z.json()),
})
const failure = (
  kind: "validation" | "runtime" | "timeout",
  message: string
): EvaluatorRunResult => ({
  score: null,
  passed: null,
  error: { kind, message },
})

export function mapLibraryInputs(
  config: ScorerInput,
  trace: TraceForEvaluation,
  datasetItem?: DatasetItemForEvaluation | null
): JsonObject {
  const parsed = scorerInputSchema.safeParse(config)
  if (!parsed.success || !parsed.data.library)
    throw new Error(
      "Invalid library scorer configuration. Check the evaluator, version, model and input mappings."
    )
  const library = parsed.data.library
  const entry = libraryEvaluator(library.evaluator)
  const roots = { trace, datasetItem }
  const args: JsonObject = {}
  for (const argument of entry.arguments) {
    const path = library.mappings[argument]!
    let value: unknown = roots
    for (const key of path.split(".")) {
      if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
        throw new Error(
          `Missing library input: ${argument}. Check its field mapping.`
        )
      value = (value as Record<string, unknown>)[key]
    }
    if (value === undefined)
      throw new Error(
        `Missing library input: ${argument}. Check its field mapping.`
      )
    if (entry.valueType === "string" && typeof value !== "string")
      throw new Error(
        `Library input ${argument} must be a string. Select a text field.`
      )
    if (
      entry.valueType === "number" &&
      (typeof value !== "number" || !Number.isFinite(value))
    )
      throw new Error(`Library input ${argument} must be a finite number.`)
    const encoded = JSON.stringify(value)
    if (encoded.length > 64_000)
      throw new Error(
        `Library input ${argument} exceeds 64000 characters. Select a narrower field.`
      )
    args[argument] = JSON.parse(encoded)
  }
  if (JSON.stringify({ args, options: library.options }).length > 128_000)
    throw new Error("Library inputs and options exceed 128000 characters.")
  return args
}

/** Only bundled evaluators run here. Model access is brokered by the parent process. */
export async function runLibraryScorer(
  config: ScorerInput,
  trace: TraceForEvaluation,
  datasetItem?: DatasetItemForEvaluation | null,
  options: JudgeOptions = {}
): Promise<EvaluatorRunResult> {
  let args: JsonObject
  try {
    args = mapLibraryInputs(config, trace, datasetItem)
  } catch (error) {
    return failure(
      "validation",
      error instanceof Error ? error.message : "Invalid library inputs."
    )
  }
  const library = config.library!
  // Verify the installed export and let Next trace the worker's package dependencies.
  if (typeof (await import("autoevals"))[library.evaluator] !== "function")
    return failure(
      "runtime",
      "The configured library evaluator is not installed."
    )
  const usesModel = libraryEvaluator(library.evaluator).modelRequired
  const metadata: JsonObject = {
    scorerType: "library",
    library: {
      package: library.package,
      version: library.version,
      adapterVersion: library.adapterVersion,
      evaluator: library.evaluator,
    },
    libraryInputs: args,
  }
  if (options.creditOperations) {
    metadata.fundingSource = "datool"
    metadata.creditOperations = options.creditOperations
  }
  if (usesModel) {
    try {
      assertJudgeConfigured(options)
    } catch (error) {
      return diagnosticResult(
        error instanceof ProviderExecutionError
          ? error.diagnostic
          : {
              category: "configuration",
              message:
                "Configure the library scorer's model provider in project settings.",
            },
        metadata
      )
    }
    metadata.judgeProvider = config.provider!
    metadata.judgeModel = config.model
    metadata.judgeStartedAt = new Date().toISOString()
  }
  const binary = resolveNodeBinary()
  if (!binary)
    return failure(
      "runtime",
      "A Node.js runtime is required for library scorers."
    )
  const timeoutMs = Math.min(
    Math.max(options.timeoutMs ?? (usesModel ? 60_000 : 5_000), 10),
    usesModel ? 60_000 : 5_000
  )
  const transport = judgeTransport(options.fetch ?? fetch, timeoutMs)
  const controller = new AbortController()
  const worker = join(
    process.cwd(),
    "src/server/sandbox/library-evaluator-worker.mjs"
  )
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      [
        "--max-old-space-size=128",
        "--permission",
        `--allow-fs-read=${worker}`,
        `--allow-fs-read=${process.cwd()}/node_modules`,
        worker,
      ],
      {
        env: Object.create(null) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      }
    )
    let settled = false
    let received = 0
    let buffer = ""
    let requests = 0
    const finish = (result: EvaluatorRunResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      controller.abort()
      child.kill("SIGKILL")
      resolve({
        ...result,
        metadata: {
          ...metadata,
          ...result.metadata,
          ...(usesModel
            ? {
                judgeAttempts: transport.attempts,
                judgeEndedAt: new Date().toISOString(),
              }
            : {}),
        },
      })
    }
    const timer = setTimeout(
      () =>
        finish(
          usesModel
            ? diagnosticResult({
                category: "timeout",
                message: "Library evaluator exceeded its wall-clock timeout.",
              })
            : failure(
                "timeout",
                "Library evaluator exceeded its wall-clock timeout."
              )
        ),
      timeoutMs
    )
    child.once("error", () =>
      finish(
        failure("runtime", "Could not start the library evaluator worker.")
      )
    )
    child.once("close", () =>
      finish(
        failure("runtime", "Library evaluator exited without a valid result.")
      )
    )
    child.stdin.on("error", () => {
      /* Worker exit is handled above. */
    })
    child.stderr.on("data", (chunk: Buffer) => {
      received += chunk.length
      if (received > MAX_BYTES)
        finish(
          failure("runtime", "Library evaluator exceeded its output limit.")
        )
    })
    async function handle(line: string) {
      if (settled) return
      try {
        const message = JSON.parse(line)
        if (message.type === "request") {
          const request = requestSchema.parse(message)
          if (
            !usesModel ||
            ++requests > 1 ||
            request.body.model !== config.model
          )
            throw new Error("Invalid model request")
          metadata.judgeMessages =
            request.body.messages ?? request.body.input ?? []
          const body = { ...request.body }
          delete body.max_tokens
          body[
            request.endpoint === "responses"
              ? "max_output_tokens"
              : config.model.startsWith("openai/")
                ? "max_completion_tokens"
                : "max_tokens"
          ] = 4096
          const response = await transport.fetch(
            `${options.baseUrl!.replace(/\/$/, "")}/${request.endpoint}`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                authorization: `Bearer ${options.apiKey}`,
              },
              signal: controller.signal,
              body: JSON.stringify(body),
            }
          )
          const reader = response.body?.getReader()
          if (!reader) throw new Error("Empty provider response")
          const chunks: Uint8Array[] = []
          let bytes = 0
          try {
            for (;;) {
              const { done, value } = await reader.read()
              if (done) break
              bytes += value.byteLength
              if (bytes > MAX_BYTES)
                throw new Error("Provider response too large")
              chunks.push(value)
            }
          } finally {
            void reader.cancel().catch(() => {})
          }
          const completion = JSON.parse(Buffer.concat(chunks).toString("utf8"))
          if (
            request.endpoint === "responses"
              ? completion.status !== "completed"
              : !["stop", "tool_calls"].includes(
                  completion.choices?.[0]?.finish_reason
                ) || completion.choices?.[0]?.message?.refusal
          )
            throw new Error("Incomplete provider response")
          const usage = completion.usage
          metadata.judge = await priceLlmWithCatalog(
            {
              "gen_ai.provider.name":
                options.provider === DATOOL_PROVIDER
                  ? "openai"
                  : config.model.split("/")[0],
              "gen_ai.response.model": completion.model ?? config.model,
              ...(usage
                ? {
                    "gen_ai.usage.input_tokens":
                      usage.prompt_tokens ?? usage.input_tokens,
                    "gen_ai.usage.output_tokens":
                      usage.completion_tokens ?? usage.output_tokens,
                    "gen_ai.usage.cache_read.input_tokens":
                      usage.prompt_tokens_details?.cached_tokens ??
                      usage.input_tokens_details?.cached_tokens,
                  }
                : {}),
            },
            options.pricing ? new PricingCatalog(options.pricing) : undefined
          )
          if (!settled)
            child.stdin.write(
              `${JSON.stringify({ id: request.id, body: completion })}\n`
            )
        } else if (message.type === "result") {
          const result = scoreSchema.parse(message.result)
          if (result.error || JSON.stringify(result).length > 32_000)
            throw new Error("Invalid library result")
          const details = result.metadata ?? {}
          finish({
            score: result.score,
            passed:
              result.score === null || config.threshold === null
                ? null
                : result.score >= config.threshold,
            ...(typeof details.rationale === "string"
              ? { reasoning: details.rationale }
              : {}),
            metadata: {
              libraryResult: { name: result.name, ...details },
              ...(result.score === null ? { skipped: true } : {}),
            },
          })
        } else throw new Error("Library evaluation failed")
      } catch (error) {
        finish(
          error instanceof ProviderExecutionError
            ? diagnosticResult(error.diagnostic)
            : diagnosticResult({
                category: "invalid_response",
                message:
                  "Library evaluation failed. Check input types, JSON Schema and model support for tool calling.",
              })
        )
      }
    }
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      received += Buffer.byteLength(chunk)
      if (received > MAX_BYTES)
        return finish(
          failure("runtime", "Library evaluator exceeded its output limit.")
        )
      buffer += chunk
      let newline: number
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void handle(line)
      }
    })
    child.stdin.write(
      `${JSON.stringify({ evaluator: library.evaluator, args, options: library.options, model: config.model, useCoT: config.chainOfThought, ...(options.provider === DATOOL_PROVIDER ? { useResponsesApi: true } : {}) })}\n`
    )
  })
}
