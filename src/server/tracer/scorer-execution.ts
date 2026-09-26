import type {
  DatasetItemForEvaluation,
  EvaluatorRunResult,
  EvaluatorVersion,
  JsonObject,
  JsonValue,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"
import { runTracerEffect } from "./effect"
import { executeScorer } from "./scorer-runtime"
import type { TracerService } from "./service"
import type { TracerDatabase } from "./db"

/** Execution history is visible in the inspector, never fed back into a scorer. */
export function scorerEvidence(trace: TraceForEvaluation): TraceForEvaluation {
  return {
    id: trace.id,
    ...(trace.group ? { group: trace.group } : {}),
    ...(trace.selectedSpanId ? { selectedSpanId: trace.selectedSpanId } : {}),
    ...(trace.provenance ? { provenance: trace.provenance } : {}),
    name: trace.name,
    operation: trace.operation,
    sessionId: trace.sessionId,
    status: trace.status,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    input: trace.input,
    output: trace.output,
    attributes: trace.attributes,
    spans: trace.spans.filter(span => span.kind !== "score" && span.attributes["datool.scorer.execution"] !== true),
    ...(trace.linkedTraces ? { linkedTraces: trace.linkedTraces.map(scorerEvidence) } : {}),
  }
}

/** Every attempt owns a fresh span, including previews against recorded traces. */
export async function executeScorerWithSpan(
  service: Pick<TracerService, "createSpan" | "patchSpan">,
  options: {
    version: EvaluatorVersion
    trace: TraceForEvaluation
    datasetItem?: DatasetItemForEvaluation | null
    projectId: string
    database?: TracerDatabase
    name?: string
    runId?: string
    targetId?: string
    timeoutMs?: number
    skippedError?: string
  }
): Promise<EvaluatorRunResult> {
  const { version, datasetItem, projectId } = options
  const trace = scorerEvidence(options.trace)
  const attributes: JsonObject = {
    "datool.scorer.execution": true,
    "scorer.id": version.evaluatorId,
    "scorer.version_id": version.id,
    "scorer.version": version.version,
    "scorer.type": version.config?.type ?? version.language,
    "scorer.preview": !options.runId,
    ...(trace.selectedSpanId ? { "scorer.source_span_id": trace.selectedSpanId } : {}),
    ...(options.runId ? { "eval.run_id": options.runId } : {}),
    ...(options.targetId ? { "eval.target_id": options.targetId } : {}),
    ...(datasetItem ? { "dataset.item_id": datasetItem.id } : {}),
    ...(options.skippedError ? {
      "scorer.skipped": true,
      "scorer.skip_reason": "The source trace failed before scoring could run.",
    } : {}),
  }
  const input = JSON.parse(JSON.stringify({ trace, datasetItem: datasetItem ?? null, scorer: version })) as JsonObject
  const span = await runTracerEffect(service.createSpan(trace.id, {
    kind: "score",
    name: options.name ?? version.config?.name ?? "Scorer",
    status: "running",
    startedAt: new Date().toISOString(),
    attributes,
    input,
  }))
  let result: EvaluatorRunResult
  try {
    result = options.skippedError
      ? {
          score: null,
          passed: null,
          error: { kind: "runtime", message: `Scorer was not run because the source trace failed. ${options.skippedError}` },
        }
      : await executeScorer(version, trace, datasetItem, projectId, options.database, { timeoutMs: options.timeoutMs })
  } catch (error) {
    result = {
      score: null,
      passed: null,
      error: { kind: "runtime", message: error instanceof Error ? error.message : "Scoring failed" },
    }
  }
  result = { ...result, metadata: { ...result.metadata, scorerSpanId: span.id } }
  const { metadata, ...output } = result
  await runTracerEffect(service.patchSpan(span.id, {
    status: result.error ? "errored" : "completed",
    endedAt: new Date().toISOString(),
    ...(result.metadata?.judgeMessages ? {
      input: { ...input, judgeMessages: result.metadata.judgeMessages },
    } : {}),
    output: JSON.parse(JSON.stringify(output)) as JsonValue,
    attributes: {
      ...metadata,
      ...attributes,
      ...(result.error ? { "error.type": result.error.kind, "error.message": result.error.message } : {}),
    },
  }))
  return result
}
