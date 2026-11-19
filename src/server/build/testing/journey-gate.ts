import { sql } from "drizzle-orm"
import {
  agentEvaluationInputSchema,
  agentFingerprintAttribute,
  readJourneyResult,
} from "@/src/lib/build/agent-journey"
import type { ManagedAgent } from "@/src/lib/build/contracts"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import type { BuildContext } from "../context"
import {
  captureEvaluationCatalog,
  evaluationFingerprint,
} from "./evaluation-catalog"

/** Only completed evidence for the exact candidate, current case and configured scorers can publish. */
export async function requirePassingJourneys(
  context: BuildContext,
  agent: ManagedAgent,
  sourceRevision?: number
) {
  const catalog = await captureEvaluationCatalog(
    context,
    agent,
    sourceRevision,
    true
  )
  const fingerprint = evaluationFingerprint(agent.configuration, catalog)
  const rows = await context.database.execute<{
    input: unknown
    expectedOutput: unknown
    metadata: unknown
    evidence: {
      datasetItem?: {
        input: unknown
        expectedOutput: unknown
        metadata: unknown
      }
      trace?: { input: unknown; attributes?: Record<string, unknown> }
    } | null
    stage: string | null
    runStatus: string | null
    scorerCount: number
    completedScorers: number
    badScorers: number
  }>(sql`
    select i.input_json::jsonb as input, i.expected_output_json::jsonb as "expectedOutput", i.metadata_json::jsonb as metadata,
      latest.evidence, latest.stage, latest."runStatus",
      (select count(*) from eval_run_evaluators e where e.project_id=${context.projectId} and e.run_id=latest.run_id)::integer as "scorerCount",
      (select count(*) from eval_results e where e.project_id=${context.projectId} and e.run_id=latest.run_id and e.target_id=latest.target_id)::integer as "completedScorers",
      (select count(*) from eval_results e where e.project_id=${context.projectId} and e.run_id=latest.run_id and e.target_id=latest.target_id and (e.passed is distinct from true or e.error is not null))::integer as "badScorers"
    from dataset_items i join datasets d on d.project_id=i.project_id and d.id=i.dataset_id
    left join lateral (
      select t.snapshot_json::jsonb as evidence, t.stage, r.status as "runStatus", r.id as run_id, t.id as target_id
      from eval_run_targets t join eval_runs r on r.project_id=t.project_id and r.id=t.run_id
      where t.project_id=i.project_id and r.agent_id=${agent.id} and r.dataset_id=i.dataset_id
        and (t.dataset_item_id=i.id or t.snapshot_json::jsonb #>> '{datasetItem,id}'=i.id)
        and t.snapshot_json::jsonb->'trace'->'attributes'->>${agentFingerprintAttribute}=${fingerprint}
      order by r.created_at desc, r.id desc, t.ordinal limit 1
    ) latest on true
    where i.project_id=${context.projectId} and d.agent_id=${agent.id}
      and jsonb_typeof(i.input_json::jsonb)='object' and i.input_json::jsonb ? 'journey'
      and i.input_json::jsonb #> '{journey,required}' is distinct from 'false'::jsonb
    limit 1001 for share of i,d
  `)
  if (!rows.rows.length)
    throw new Error(
      "Add and pass at least one required customer journey before publishing this agent."
    )
  if (rows.rows.length > 1000)
    throw new Error(
      "An agent can require at most 1,000 customer journeys before publishing."
    )
  const failures = rows.rows.flatMap((row) => {
    const parsed = agentEvaluationInputSchema.safeParse(row.input)
    if (
      !parsed.success ||
      typeof parsed.data === "string" ||
      !parsed.data.journey
    )
      return ["A required journey has invalid input."]
    const report = readJourneyResult(row.evidence?.trace?.attributes)
    const matchesCase =
      row.evidence?.datasetItem &&
      canonicalJson(row.input) === canonicalJson(row.evidence.trace?.input) &&
      canonicalJson(row.expectedOutput) ===
        canonicalJson(row.evidence.datasetItem.expectedOutput) &&
      canonicalJson(row.metadata) ===
        canonicalJson(row.evidence.datasetItem.metadata)
    return row.stage === "completed" &&
      row.runStatus !== "cancelled" &&
      matchesCase &&
      report?.status === "passed" &&
      report.fingerprint === fingerprint &&
      row.completedScorers === row.scorerCount &&
      row.badScorers === 0
      ? []
      : [parsed.data.journey.name]
  })
  if (failures.length)
    throw new Error(
      `Run and pass the required journeys for these saved changes before publishing: ${failures.slice(0, 5).join(", ")}${failures.length > 5 ? "…" : ""}.`
    )
  return catalog
}
