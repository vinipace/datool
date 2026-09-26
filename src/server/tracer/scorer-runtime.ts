import { diagnosticResult } from "./runtime-diagnostics"
import { runLibraryScorer } from "./library-scorer"
import { libraryEvaluator } from "@/src/lib/tracer/scorer-libraries"
import { runLlmScorer } from "./llm-scorer"
import { resolveJudgeOptions } from "@/src/server/model-providers/judge"
import type {
  EvaluatorVersion,
  EvaluatorRunResult,
  TraceForEvaluation,
  DatasetItemForEvaluation,
} from "@/src/lib/tracer/contracts"
import { runEvaluator, runPythonEvaluator } from "@/src/server/sandbox/evaluator"
import { runSandboxScorer } from "@/src/server/sandbox/run-scorer"
import type { TracerDatabase } from "./db"

export async function executeScorer(
  version: EvaluatorVersion,
  trace: TraceForEvaluation,
  datasetItem?: DatasetItemForEvaluation | null,
  projectId?: string,
  database?: TracerDatabase,
  options?: { timeoutMs?: number }
): Promise<EvaluatorRunResult> {
  const config = version.config
  if (config?.type === "library") {
    try {
      const judge = config.library && libraryEvaluator(config.library.evaluator)?.modelRequired
        ? await resolveJudgeOptions(config, projectId, database) : {}
      return await runLibraryScorer(config, trace, datasetItem, { ...judge, ...options })
    } catch {
      return diagnosticResult({ category: "configuration", message: "Configure the library scorer's model provider in project settings." })
    }
  }
  // Always evaluate the available evidence, including for older saved versions.
  if (config?.type === "llm") {
    try {
      return await runLlmScorer(config, trace, datasetItem, { ...await resolveJudgeOptions(config, projectId, database), ...options })
    } catch (error) {
      return diagnosticResult({ category: "configuration", message: error instanceof Error && error.message.startsWith("Configure ") ? error.message : "Unable to configure the LLM scorer. Check this project's selected provider key and model." }, { judgeErrorField: "model" })
    }
  }
  const python = config?.type === "python" || (!config && version.language === "python")
  const run = python
    ? runPythonEvaluator : runEvaluator
  const input = { code: version.code, trace, datasetItem }
  // Unscoped callers are trusted local tooling. Every project/API scorer uses
  // its configured container providers, including previews and evaluations.
  const result = projectId
    ? await runSandboxScorer(projectId, python ? "python" : "javascript", input, { database, ...(options?.timeoutMs ? { deadlineMs: Date.now() + options.timeoutMs } : {}) })
    : await run(input)
  if (!result.error && result.score !== null && config?.threshold != null)
    result.passed = result.score >= config.threshold
  return result
}
