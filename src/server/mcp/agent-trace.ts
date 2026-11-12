import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import { db } from "@/lib/db"
import {
  decryptProviderKey,
  encryptProviderKey,
} from "../model-providers/secrets"

type AgentMcpTrace = { projectId: string; traceId: string; spanId: string }
const activeTrace = new AsyncLocalStorage<AgentMcpTrace | undefined>()
const header = "x-datool-agent-trace"
const purpose = "mcp-agent-trace:v1"
const digest = (body: unknown) =>
  createHash("sha256").update(JSON.stringify(body)).digest("hex")

/** Scope correlation to the persisted agent tool span, including MCP discovery. */
export function withAgentMcpTrace<T>(
  trace: AgentMcpTrace | undefined,
  action: () => Promise<T>
) {
  return activeTrace.run(trace, action)
}

/** Never send internal correlation to another installation or an OAuth endpoint. */
export function agentMcpTraceHeaders(
  url: URL,
  body: string | undefined
): Record<string, string> {
  const trace = activeTrace.getStore()
  const origin = process.env.BETTER_AUTH_URL
  if (!trace || !origin || !body) return {}
  if (
    !/^\/api\/(?:project-mcp(?:\/[^/]+)?|mcp(?:\/trace-explorer)?)$/.test(
      url.pathname
    )
  )
    return {}
  try {
    if (url.origin !== new URL(origin).origin) return {}
    return {
      [header]: encryptProviderKey(
        JSON.stringify({
          traceId: trace.traceId,
          spanId: trace.spanId,
          url: url.href,
          body: digest(JSON.parse(body)),
          expiresAt: Date.now() + 60_000,
        }),
        trace.projectId,
        purpose
      ),
    }
  } catch {
    // Missing correlation must fall back to ordinary MCP logging.
    return {}
  }
}

/** A caller-supplied trace ID alone must never suppress a log or cross projects. */
export async function existingAgentMcpTrace(
  request: Request,
  body: unknown,
  projectId: string
) {
  const proof = request.headers.get(header)
  if (!proof || proof.length > 4096) return null
  try {
    const claim = JSON.parse(decryptProviderKey(proof, projectId, purpose))
    if (
      typeof claim.traceId !== "string" ||
      typeof claim.spanId !== "string" ||
      claim.url !== request.url ||
      claim.body !== digest(body) ||
      !Number.isFinite(claim.expiresAt) ||
      claim.expiresAt < Date.now() ||
      claim.expiresAt > Date.now() + 120_000
    )
      return null
    const { rows } = await db.query(
      `SELECT t.id FROM traces t JOIN spans s ON s.project_id=t.project_id AND s.trace_id=t.id
       WHERE t.project_id=$1 AND t.id=$2 AND s.id=$3 AND t.status='running'
       AND s.status='running' AND s.kind='tool' AND s.attributes_json->>'build.engine'='eve'`,
      [projectId, claim.traceId, claim.spanId]
    )
    return (rows[0]?.id as string | undefined) ?? null
  } catch {
    return null
  }
}
