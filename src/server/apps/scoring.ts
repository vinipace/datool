import type { ResolvedApp } from "./invoke"
import type { TracerService } from "@/src/server/tracer/service"
import type { JsonValue } from "@/src/lib/tracer/contracts"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { validation } from "@/src/server/tracer/errors"
import { workspaceIdentity } from "@/src/server/auth/context"
import { requireScopes } from "@/src/server/auth/request"
import { assertJudgeConfigured } from "@/src/server/tracer/llm-scorer"
import { resolveJudgeOptions } from "@/src/server/model-providers/judge"

export function selectedScorers(query: string | null, defaults: string[]) {
  const ids = query === null ? defaults : query ? query.split(",") : []
  if (ids.length > 10 || ids.some((id) => !id.trim() || id.length > 200))
    throw validation("Select at most 10 scorers.")
  return [...new Set(ids)]
}

/** Check access and freeze scorer versions before spending time on a workflow. */
export async function prepareAppScoring(service: TracerService, ids: string[]) {
  const identity = workspaceIdentity()
  requireScopes(
    identity?.scopes ?? [],
    ids.length ? ["evals:write", "scorers:read"] : ["evals:write"]
  )
  const versions: Record<string, string> = {}
  for (const id of ids) {
    const evaluator = await runTracerEffect(service.getEvaluator(id))
    const config = evaluator.activeVersion.config
    if (config?.type === "llm")
      assertJudgeConfigured(
        await resolveJudgeOptions(config, identity!.projectId)
      )
    versions[id] = evaluator.activeVersion.id
  }
  return versions
}

/** Every playground invocation is a persisted experiment, even without scorers. */
export async function runAppExperiment(
  service: TracerService,
  app: ResolvedApp,
  input: JsonValue,
  versions: Record<string, string>
) {
  const experiment = await runTracerEffect(
    service.createEvalRun({
      name: `Playground · ${app.definition.name}`,
      mode: "connected",
      appId: app.definition.id,
      input,
      evaluatorIds: Object.keys(versions),
      evaluatorVersionIds: versions,
      metadata: { source: "playground", appId: app.definition.id },
    })
  )
  const traceId = experiment.rows?.[0]?.trace.id
  if (!traceId) throw new Error("The experiment has no captured invocation.")
  const trace = await runTracerEffect(service.getTraceArtifact(traceId))
  return { experiment, trace }
}
