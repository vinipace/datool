import { sql } from "drizzle-orm"
import type { CreateEvalRunInput, JsonObject } from "@/src/lib/tracer/contracts"
import type {
  FrozenPromptConfig,
  PromptOverrides,
} from "@/src/lib/tracer/prompt-overrides"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { notFound, validation } from "./errors"

/** Existing runs are the iteration history. No separately managed configuration is needed. */
export async function resolveRunIteration(
  database: TracerDatabase,
  raw: CreateEvalRunInput
) {
  const id = raw.parentRunId ?? raw.sourceRunId
  if (!id) {
    if (raw.useRecordedVersions)
      throw validation(
        "useRecordedVersions requires parentRunId or sourceRunId."
      )
    return { input: raw, parent: null }
  }
  if (
    raw.parentRunId &&
    (raw.sourceRunId ||
      raw.datasetId ||
      raw.datasetVersionId ||
      raw.datasetItemIds ||
      raw.traceIds ||
      raw.input !== undefined ||
      raw.mode === "traces")
  )
    throw validation(
      "parentRunId starts a fresh app execution with the parent's frozen cases. Do not combine it with other targets; use sourceRunId to re-score outputs."
    )
  const project = getTracerProjectId(database)
  const row = (
    await database.execute(
      sql`select status,dataset_id,metadata_json::jsonb as metadata from eval_runs where project_id=${project} and id=${id}`
    )
  ).rows[0]
  if (!row) throw notFound("Eval run", id)
  if (row.status === "running")
    throw validation(
      "Wait for the source run to finish or cancel it before iterating."
    )
  const metadata = row.metadata as JsonObject
  const versions = (
    await database.execute(
      sql`select evaluator_id,evaluator_version_id from eval_run_evaluators where project_id=${project} and run_id=${id} order by evaluator_id`
    )
  ).rows
  const evaluatorIds =
    raw.evaluatorIds ?? versions.map((v) => String(v.evaluator_id))
  const recorded = Object.fromEntries(
    versions
      .filter((v) => evaluatorIds.includes(String(v.evaluator_id)))
      .map((v) => [String(v.evaluator_id), String(v.evaluator_version_id)])
  )
  const input: CreateEvalRunInput = {
    ...raw,
    evaluatorIds,
    ...(raw.useRecordedVersions
      ? { evaluatorVersionIds: { ...recorded, ...raw.evaluatorVersionIds } }
      : {}),
  }
  const prompts = metadata.promptConfig as FrozenPromptConfig | undefined
  if (raw.parentRunId) {
    const app = (metadata.app ?? metadata.sourceApp) as { id?: string } | null
    if (!app?.id)
      throw validation(
        "This run has no recorded app. Select an app and dataset explicitly."
      )
    input.mode = "connected"
    input.appId ??= app.id
    input.datasetId =
      typeof row.dataset_id === "string" ? row.dataset_id : undefined
    input.inputOverrides = {
      ...(metadata.inputOverrides as JsonObject | undefined),
      ...raw.inputOverrides,
    }
    if (!Object.keys(input.inputOverrides).length) delete input.inputOverrides
    // Explicit model choices are reusable settings; omitted versions resolve latest.
    const overrides: PromptOverrides = Object.fromEntries(
      Object.entries(prompts?.overrides ?? {})
        .filter(([, value]) => value.model)
        .map(([slug, value]) => [slug, { model: value.model }])
    )
    if (raw.useRecordedVersions)
      for (const [slug, value] of Object.entries(prompts?.prompts ?? {}))
        overrides[slug] = { version: value.version, model: value.model }
    input.promptOverrides = { ...overrides }
    for (const [slug, value] of Object.entries(raw.promptOverrides ?? {}))
      input.promptOverrides[slug] = {
        ...overrides[slug],
        ...Object.fromEntries(
          Object.entries(value).filter(([, v]) => v !== undefined)
        ),
      }
    if (!Object.keys(input.promptOverrides).length) delete input.promptOverrides
    input.concurrency ??=
      typeof metadata.concurrency === "number"
        ? metadata.concurrency
        : undefined
  }
  return {
    input,
    parent: {
      id,
      metadata,
      scorerVersions: Object.fromEntries(
        versions.map((v) => [
          String(v.evaluator_id),
          String(v.evaluator_version_id),
        ])
      ),
      prompts,
    },
  }
}
