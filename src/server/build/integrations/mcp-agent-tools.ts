import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { actionDefinitionSchema } from "@/src/lib/build/contracts"
import { scopedTracerTransaction } from "@/src/server/tracer/db"
import { TracerError } from "@/src/server/tracer/errors"
import { assertBuildProject, type BuildContext } from "../context"
import { getAgent, updateAgent } from "../agents"
import { listActions } from "../definitions"
import { buildActions, buildActionRevisions } from "../catalog-schema"
import { listAppTools } from "./service"

/** Connecting an account and publishing its tools are distinct authorizations.
 * Import once into this agent's ordinary action catalog so revisions, channel
 * restrictions, approvals, traces and revocation retain their existing owner.
 */
export async function enableMcpTools(
  context: BuildContext,
  agentId: string,
  connectionId: string
) {
  const ctx = await assertBuildProject(context)
  await getAgent(ctx, agentId)
  const connection = (
    await ctx.database.execute<{ label: string }>(
      sql`SELECT label FROM build_app_connections WHERE id=${connectionId}::uuid AND project_id=${ctx.projectId} AND toolkit='custom_mcp' AND status='active'`
    )
  ).rows[0]
  if (!connection)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Connect this MCP server before enabling its tools."
    )
  // Discovery happens before the transaction; a large catalog needs one request,
  // rather than a discovery request for every imported action.
  const tools = await listAppTools(ctx, connectionId)
  if (tools.length > 1000)
    throw new TracerError(
      "VALIDATION_ERROR",
      "This server has too many tools to enable at once. Choose individual tools in Actions."
    )
  return ctx.database.transaction(async (tx) => {
    const scoped = {
      ...ctx,
      database: scopedTracerTransaction(ctx.database, tx),
    }
    await tx.execute(
      sql`SELECT id FROM build_agents WHERE id=${agentId} AND project_id=${ctx.projectId} FOR UPDATE`
    )
    const latest = await getAgent(scoped, agentId)
    const existing = await listActions(scoped, agentId)
    const known = new Set(
      existing.flatMap((item) =>
        item.definition.type === "integration" &&
        item.definition.connectionId === connectionId
          ? [item.definition.toolSlug]
          : []
      )
    )
    const now = new Date().toISOString()
    const rows = tools
      .filter((tool) => !known.has(tool.slug))
      .map((tool) => {
        const id = `mcp_${createHash("sha256")
          .update(JSON.stringify([agentId, connectionId, tool.slug]))
          .digest("hex")}`
        return {
          id,
          projectId: ctx.projectId,
          agentId,
          slug: id.replace("_", "-"),
          revision: 1,
          definitionJson: actionDefinitionSchema.parse({
            id,
            type: "integration",
            name: `${connection.label}: ${tool.name}`.slice(0, 160),
            description: tool.description.slice(0, 2000),
            connectionId,
            toolSlug: tool.slug,
            ...(tool.originalName ? { mcpToolName: tool.originalName } : {}),
            inputSchema: tool.inputSchema,
          }),
          encryptedHeaders: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        }
      })
    const bySlug = new Map(tools.map((tool) => [tool.slug, tool]))
    const updated = []
    for (const record of existing) {
      const definition = record.definition
      if (
        definition.type !== "integration" ||
        definition.connectionId !== connectionId
      )
        continue
      const originalName = bySlug.get(definition.toolSlug)?.originalName
      if (!originalName || originalName === definition.mcpToolName) continue
      const next = actionDefinitionSchema.parse({
        ...definition,
        mcpToolName: originalName,
      })
      const revision = record.revision + 1
      await tx.execute(
        sql`UPDATE build_actions SET definition_json=${JSON.stringify(next)}::jsonb,revision=${revision},updated_at=${now}::timestamptz WHERE id=${record.id} AND project_id=${ctx.projectId} AND agent_id=${agentId} AND revision=${record.revision}`
      )
      updated.push({
        id: randomUUID(),
        projectId: ctx.projectId,
        actionId: record.id,
        agentId,
        slug: record.slug,
        revision,
        definitionJson: next,
        encryptedHeaders: null,
        createdAt: now,
        createdBy: ctx.actorId ?? null,
      })
    }
    if (updated.length) await tx.insert(buildActionRevisions).values(updated)
    if (rows.length) {
      await tx.insert(buildActions).values(rows)
      await tx.insert(buildActionRevisions).values(
        rows.map((row) => ({
          id: randomUUID(),
          projectId: ctx.projectId,
          actionId: row.id,
          agentId,
          slug: row.slug,
          revision: 1,
          definitionJson: row.definitionJson,
          encryptedHeaders: null,
          createdAt: now,
          createdBy: ctx.actorId ?? null,
        }))
      )
    }
    // Apply the catalog atomically. A running turn keeps its previous snapshot.
    const agent =
      rows.length || updated.length
        ? await updateAgent(scoped, agentId, {
            expectedRevision: latest.currentRevision,
            apply: true,
          })
        : latest
    const enabled =
      existing.filter(
        (item) =>
          item.definition.type === "integration" &&
          item.definition.connectionId === connectionId &&
          item.definition.enabled
      ).length + rows.length
    return {
      agentId,
      connectionId,
      imported: rows.length,
      updated: updated.length,
      enabled,
      agentRevision: agent.currentRevision,
    }
  })
}
