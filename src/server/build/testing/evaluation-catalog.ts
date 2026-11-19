import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import type {
  AgentConfiguration,
  ManagedAgent,
} from "@/src/lib/build/contracts"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import type { BuildContext } from "../context"
import {
  getRuntimeAppliedDefinitions,
  listActions,
  listProcedures,
  listWidgets,
  type AppliedAgentDefinitions,
} from "../definitions"

type KnowledgeRevision = {
  id: string
  activeRevision: number | null
  contentHash: string | null
  revision: number
}
export type EvaluationCatalog = AppliedAgentDefinitions & {
  knowledge: KnowledgeRevision[]
}

export async function captureEvaluationCatalog(
  context: BuildContext,
  agent: ManagedAgent,
  sourceRevision?: number,
  lockKnowledge = false
): Promise<EvaluationCatalog> {
  const catalog =
    sourceRevision !== undefined
      ? await getRuntimeAppliedDefinitions(context, agent.id, sourceRevision)
      : await (async () => {
          const [actions, procedures, widgets] = await Promise.all([
            listActions(context, agent.id),
            listProcedures(context, agent.id),
            listWidgets(context, agent.id),
          ])
          return {
            projectId: context.projectId,
            agentId: agent.id,
            agentRevision: agent.currentRevision,
            actions,
            procedures,
            widgets,
          }
        })()
  const knowledge = await context.database.execute<KnowledgeRevision>(sql`
    select id, active_revision as "activeRevision", content_hash as "contentHash", revision
    from build_knowledge_sources where project_id=${context.projectId} and agent_id=${agent.id} and status<>'deleted' order by id ${lockKnowledge ? sql`for share` : sql``}
  `)
  return { ...catalog, knowledge: knowledge.rows }
}

/** Revision references also detect changed credentials without hashing or exposing secrets. */
export function evaluationFingerprint(
  configuration: AgentConfiguration,
  catalog: EvaluationCatalog
) {
  const refs = (
    items: Array<{ id: string; revision: number; definition: unknown }>
  ) =>
    items
      .map(({ id, revision, definition }) => ({ id, revision, definition }))
      .sort((a, b) => a.id.localeCompare(b.id))
  return createHash("sha256")
    .update(
      canonicalJson({
        configuration,
        actions: refs(catalog.actions),
        procedures: refs(catalog.procedures),
        widgets: refs(catalog.widgets),
        knowledge: catalog.knowledge,
      })
    )
    .digest("hex")
}
