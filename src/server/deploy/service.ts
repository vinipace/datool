import { createHash, randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"
import { buildEnabled } from "@/lib/build/config"
import { agentConfigurationSchema } from "@/src/lib/build/contracts"
import { chunkKnowledgeText } from "@/src/lib/build/knowledge"
import {
  brainTool,
  deployInput,
  deploymentTool,
  deploymentDocument,
  type DeploymentBundle,
  type DeploymentTool,
} from "@/src/lib/deploy/contracts"
import type { AgentSandboxProvider } from "@/src/lib/build/sandbox"
import { assertBuildProject, type BuildContext } from "../build/context"
import {
  getSandboxExecutionProviders,
  getSandboxProviderCredentials,
} from "../sandbox/providers-store"
import { storageConnection } from "../build/storage/connections"
import { createAgent, updateAgent, getAgent } from "../build/agents"
import {
  listActions,
  saveAction,
  listProcedures,
  saveProcedure,
} from "../build/definitions"
import { scopedTracerTransaction } from "../tracer/db"
import { TracerError } from "../tracer/errors"
import {
  executeDeploymentModule,
  validateToolInput,
  validateDeploymentSchema,
} from "./execute"
import { searchBrain } from "./capabilities"

type DeploymentRow = {
  id: string
  project_id: string
  content_hash: string
  bundle_json: DeploymentBundle
  tools_json: DeploymentTool[]
  sandbox_provider: AgentSandboxProvider
  created_at: Date
}
async function ready(context: BuildContext) {
  const scope = await assertBuildProject(context)
  if (!buildEnabled(scope.organizationId))
    throw new TracerError(
      "UNAUTHORIZED",
      "Build is not enabled for this organization.",
      { status: 403 }
    )
  return scope
}
export async function getDeployment(context: BuildContext, id?: string) {
  await ready(context)
  const rows = id
    ? await context.database.execute<DeploymentRow>(
        sql`SELECT * FROM project_deployments WHERE project_id=${context.projectId} AND id=${id}::uuid`
      )
    : await context.database.execute<DeploymentRow>(
        sql`SELECT d.* FROM project_deployments d JOIN project_deployment_state s ON s.project_id=d.project_id AND s.active_id=d.id WHERE d.project_id=${context.projectId}`
      )
  return rows.rows[0] ?? null
}
export function deploymentSummary(row: DeploymentRow) {
  return {
    id: row.id,
    hash: row.content_hash,
    createdAt: new Date(row.created_at).toISOString(),
    sandbox: row.sandbox_provider,
    tools: row.tools_json.map((t) => t.name),
    agents: row.bundle_json.agents.map((a) => a.slug),
    sources: row.bundle_json.sources.map((s) => s.path),
    mcpPath: `/api/project-mcp?projectId=${encodeURIComponent(row.project_id)}`,
  }
}

export async function deployProject(
  context: BuildContext,
  raw: unknown,
  signal?: AbortSignal
) {
  signal = AbortSignal.any([
    AbortSignal.timeout(210_000),
    ...(signal ? [signal] : []),
  ])
  const scope = await ready(context)
  const parsed = deployInput.safeParse(raw)
  if (!parsed.success)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Invalid deployment bundle. Run datool deploy --dry-run to check the folder."
    )
  const input = parsed.data,
    bundle = input.bundle
  const existing = await getDeployment(scope)
  if ((existing?.id ?? null) !== input.expectedDeploymentId)
    throw new TracerError(
      "CONFLICT",
      "Another deployment was published. Read deployment status before retrying."
    )
  const providers = await getSandboxExecutionProviders(
    scope.projectId,
    scope.database
  )
  const sandbox =
    bundle.config.sandbox ??
    (providers.find((p) => ["local", "modal", "boat", "datool"].includes(p.id))
      ?.id as AgentSandboxProvider | undefined)
  if (!sandbox)
    throw new Error(
      "Configure an organization sandbox provider before deploying."
    )
  await getSandboxProviderCredentials(scope.projectId, sandbox, scope.database)
  if (bundle.config.storageConnectionId)
    await storageConnection(scope, bundle.config.storageConnectionId)
  if (
    existing &&
    bundle.config.storageConnectionId !==
      existing.bundle_json.config.storageConnectionId
  )
    throw new TracerError(
      "CONFLICT",
      "The project bucket location cannot change during redeployment."
    )
  const described = z
    .object({
      tools: z.array(deploymentTool).max(64),
      collectors: z.array(z.string()).max(20),
    })
    .strict()
    .parse(
      await executeDeploymentModule(scope, {
        code: bundle.code,
        sandbox,
        mode: "describe",
        signal,
      })
    )
  if (
    JSON.stringify(described.tools.map((t) => t.name).sort()) !==
      JSON.stringify([...bundle.tools].sort()) ||
    JSON.stringify([...described.collectors].sort()) !==
      JSON.stringify([...bundle.collectors].sort())
  )
    throw new Error("Bundled exports do not match the deployment manifest.")
  for (const tool of described.tools) validateDeploymentSchema(tool.inputSchema)
  const documents = [...bundle.sources]
  for (const name of bundle.collectors) {
    const output = await executeDeploymentModule(scope, {
      code: bundle.code,
      sandbox,
      mode: "source",
      name,
      deploymentId: existing?.id,
      signal,
    })
    const sourceDocuments = z.array(deploymentDocument).max(100).parse(output)
    documents.push(
      ...sourceDocuments.map((doc) => ({
        ...doc,
        path: `sources/${name}/${doc.path}`,
      }))
    )
  }
  if (
    documents.length > 200 ||
    Buffer.byteLength(JSON.stringify(documents)) > 4 * 1024 * 1024
  )
    throw new Error("Company knowledge exceeds 200 documents or 4 MiB.")
  if (new Set(documents.map((d) => d.path)).size !== documents.length)
    throw new Error("Company sources have duplicate paths.")
  const contentHash = createHash("sha256")
    .update(
      JSON.stringify({ bundle, documents, sandbox, tools: described.tools })
    )
    .digest("hex")
  const id = randomUUID(),
    tools = [...described.tools, brainTool]
  const savedBundle = { ...bundle, sources: documents }
  // Lock the project row: first deployments and replacements share one serial publication boundary.
  return scope.database.transaction(async (tx) => {
    const scoped = {
      ...scope,
      database: scopedTracerTransaction(scope.database, tx),
    }
    await tx.execute(
      sql`SELECT id FROM project WHERE id=${scope.projectId} FOR UPDATE`
    )
    const active = await tx.execute<{ active_id: string }>(
      sql`SELECT active_id FROM project_deployment_state WHERE project_id=${scope.projectId}`
    )
    if ((active.rows[0]?.active_id ?? null) !== input.expectedDeploymentId)
      throw new TracerError(
        "CONFLICT",
        "Another deployment was published while this one was preparing."
      )
    signal!.throwIfAborted()
    if (existing?.content_hash === contentHash)
      return { ...deploymentSummary(existing), unchanged: true }
    const inserted = await tx.execute<DeploymentRow>(
      sql`INSERT INTO project_deployments(id,project_id,content_hash,bundle_json,tools_json,sandbox_provider,created_by) VALUES(${id}::uuid,${scope.projectId},${contentHash},${JSON.stringify(savedBundle)}::jsonb,${JSON.stringify(tools)}::jsonb,${sandbox},${scope.actorId ?? null}) RETURNING *`
    )
    for (const doc of documents) {
      const chunks = chunkKnowledgeText(doc.text)
      for (let ordinal = 0; ordinal < chunks.length; ordinal++) {
        await tx.execute(
          sql`INSERT INTO project_brain_chunks(project_id,deployment_id,source_path,title,ordinal,content) VALUES(${scope.projectId},${id}::uuid,${doc.path},${doc.title},${ordinal},${chunks[ordinal]})`
        )
      }
    }
    for (const definition of bundle.agents) {
      const mapping = await tx.execute<{ agent_id: string }>(
        sql`SELECT agent_id FROM project_deployed_agents WHERE project_id=${scope.projectId} AND slug=${definition.slug}`
      )
      const config = agentConfigurationSchema.parse({
        ...definition.configuration,
        instructions: definition.instructions,
      })
      let agent = mapping.rows[0]
        ? await getAgent(scoped, mapping.rows[0].agent_id, {
            includeArchived: true,
          })
        : await createAgent(scoped, {
            name: definition.slug,
            slug: definition.slug,
            configuration: config,
          })
      if (!mapping.rows[0])
        await tx.execute(
          sql`INSERT INTO project_deployed_agents(project_id,slug,agent_id) VALUES(${scope.projectId},${definition.slug},${agent.id})`
        )
      await tx.execute(
        sql`UPDATE build_agents SET status='active',archived_at=NULL WHERE project_id=${scope.projectId} AND id=${agent.id}`
      )
      const actions = await listActions(scoped, agent.id)
      for (const tool of tools) {
        const old = actions.find((a) => a.slug === tool.name)
        if (old && old.definition.type !== "deployment")
          throw new TracerError(
            "CONFLICT",
            `Agent action ${tool.name} is managed outside this deployment.`
          )
        await saveAction(scoped, agent.id, {
          id: old?.id,
          slug: tool.name,
          expectedRevision: old?.revision,
          definition: {
            id: old?.id ?? tool.name,
            name: tool.name,
            description: tool.description,
            type: "deployment",
            deploymentId: id,
            toolName: tool.name,
            inputSchema: tool.inputSchema,
          },
        })
      }
      for (const old of actions.filter(
        (a) =>
          a.definition.type === "deployment" &&
          !tools.some((t) => t.name === a.slug)
      ))
        await saveAction(scoped, agent.id, {
          id: old.id,
          expectedRevision: old.revision,
          definition: { ...old.definition, enabled: false },
        })
      const procedures = await listProcedures(scoped, agent.id)
      const skillSlugs = new Set<string>()
      for (const skill of bundle.skills) {
        const slug = `deploy-${createHash("sha256").update(skill.path).digest("hex").slice(0, 24)}`
        skillSlugs.add(slug)
        const old = procedures.find((p) => p.slug === slug)
        await saveProcedure(scoped, agent.id, {
          id: old?.id,
          slug,
          expectedRevision: old?.revision,
          definition: {
            name: skill.title,
            instructions: skill.text,
            trigger: { type: "intent", value: skill.title },
          },
        })
      }
      for (const old of procedures.filter(
        (p) => p.slug.startsWith("deploy-") && !skillSlugs.has(p.slug)
      ))
        await saveProcedure(scoped, agent.id, {
          id: old.id,
          expectedRevision: old.revision,
          definition: { ...old.definition, enabled: false },
        })
      agent = await updateAgent(scoped, agent.id, {
        expectedRevision: agent.currentRevision,
        configuration: config,
        apply: true,
      })
    }
    const retained = bundle.agents.map((a) => a.slug)
    await tx.execute(
      sql`UPDATE build_agents a SET status='archived',archived_at=now()::text WHERE a.project_id=${scope.projectId} AND EXISTS(SELECT 1 FROM project_deployed_agents d WHERE d.project_id=a.project_id AND d.agent_id=a.id ${
        retained.length
          ? sql`AND d.slug NOT IN (${sql.join(
              retained.map((slug) => sql`${slug}`),
              sql`,`
            )})`
          : sql``
      })`
    )
    signal!.throwIfAborted()
    await tx.execute(
      sql`INSERT INTO project_deployment_state(project_id,organization_id,active_id,storage_connection_id) VALUES(${scope.projectId},${scope.organizationId},${id}::uuid,${bundle.config.storageConnectionId}::uuid) ON CONFLICT(project_id) DO UPDATE SET active_id=excluded.active_id`
    )
    return { ...deploymentSummary(inserted.rows[0]), unchanged: false }
  })
}

export async function invokeDeploymentTool(
  context: BuildContext,
  deploymentId: string,
  name: string,
  input: unknown,
  signal?: AbortSignal
) {
  const row = await getDeployment(context, deploymentId)
  const tool = row?.tools_json.find((t) => t.name === name)
  if (!row || !tool)
    throw new TracerError(
      "NOT_FOUND",
      "Deployed tool was not found in this project."
    )
  if (Buffer.byteLength(JSON.stringify(input ?? {})) > 64 * 1024)
    throw new Error("Tool input exceeds 64 KiB.")
  validateToolInput(tool, input)
  if (name === "brain_search") return searchBrain(context, row.id, input)
  return executeDeploymentModule(context, {
    code: row.bundle_json.code,
    sandbox: row.sandbox_provider,
    mode: "tool",
    name,
    input,
    deploymentId: row.id,
    signal,
  })
}
