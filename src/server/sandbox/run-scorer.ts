import { runManagedSandbox } from "@/src/server/execution-credits/sandbox"
import type { EvaluatorRunResult } from "@/src/lib/tracer/contracts"
import {
  sandboxProviderNames,
  type SandboxProviderId,
} from "@/src/lib/sandbox-providers"
import type { RunEvaluatorInput } from "./evaluator"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { getSandboxExecutionProviders } from "./providers-store"
import {
  executeSandboxProvider,
  sandboxFailure,
  type SandboxJob,
} from "./provider-runtime"

export async function runSandboxScorer(
  projectId: string,
  language: SandboxJob["language"],
  input: RunEvaluatorInput,
  options: {
    providers?: typeof getSandboxExecutionProviders
    execute?: typeof executeSandboxProvider
    deadlineMs?: number
    database?: TracerDatabase
  } = {}
): Promise<EvaluatorRunResult> {
  if (!input.code?.trim() || Buffer.byteLength(input.code) > 128 * 1024)
    return sandboxFailure(
      "validation",
      "Scorer code must be non-empty and at most 128 KB."
    )
  if (
    input.timeoutMs !== undefined &&
    (!Number.isFinite(input.timeoutMs) || input.timeoutMs < 10)
  )
    return sandboxFailure(
      "validation",
      "Scorer timeout must be at least 10 ms."
    )
  const timeoutMs = Math.min(Math.floor(input.timeoutMs ?? 1000), 5000)
  let payload: string
  try {
    payload = JSON.stringify({
      code: input.code,
      trace: input.trace,
      datasetItem: input.datasetItem ?? null,
      timeoutMs,
    })
    if (Buffer.byteLength(payload) > 1024 * 1024) throw new Error()
  } catch {
    return sandboxFailure(
      "validation",
      "Scorer input must be JSON serializable and at most 1 MB."
    )
  }
  let providers: Awaited<ReturnType<typeof getSandboxExecutionProviders>>
  try {
    providers = await (options.providers ?? getSandboxExecutionProviders)(
      projectId,
      options.database
    )
  } catch {
    return sandboxFailure(
      "sandbox",
      "Unable to load this project's sandbox providers."
    )
  }
  const attempts: { provider: SandboxProviderId; status: string }[] = []
  for (const provider of providers) {
    if (options.deadlineMs !== undefined && Date.now() >= options.deadlineMs)
      return {
        ...sandboxFailure(
          "timeout",
          "Sandbox runtime probe exceeded its deadline. Check provider availability."
        ),
        metadata: {
          sandboxAttempts: attempts,
          runtimeDiagnostic: {
            category: "timeout",
            message: "Sandbox runtime probe timed out.",
          },
        },
      }
    if (provider.id === "datool") {
      const result = await runManagedSandbox(projectId, {
        language,
        payload,
        timeoutMs,
        deadlineMs: options.deadlineMs,
      })
      return {
        ...result,
        metadata: { ...result.metadata, sandboxProvider: "datool" },
      }
    }
    try {
      const result = await (options.execute ?? executeSandboxProvider)(
        provider.credentials(),
        {
          language,
          deadlineMs: options.deadlineMs,
          payload,
          timeoutMs,
        }
      )
      attempts.push({
        provider: provider.id,
        status: result.error ? "scorer-error" : "completed",
      })
      return {
        ...result,
        metadata: {
          ...result.metadata,
          sandboxProvider: provider.id,
          sandboxAttempts: attempts,
        },
      }
    } catch {
      attempts.push({ provider: provider.id, status: "unavailable" })
    }
  }
  return {
    ...sandboxFailure(
      "sandbox",
      providers.length
        ? `No sandbox provider is available (${providers.map(({ id }) => sandboxProviderNames[id]).join(", ")}). Check sandbox provider settings.`
        : "Configure a sandbox provider in project settings to run code scorers."
    ),
    metadata: { sandboxAttempts: attempts },
  }
}
