import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"
import { workspaceIdentity } from "../auth/context"
import { securityAudit } from "../security/audit"
import { runTracerEffect } from "../tracer/effect"
import { getTracerService } from "../tracer/service"
import { existingAgentMcpTrace } from "./agent-trace"

const maxPayloadBytes = 64 * 1024
const secretField =
  /^(authorization|cookie|setcookie|apikey|accesstoken|refreshtoken|token|password|secret|clientsecret|credentials)$/i

/** Keep trace payloads bounded and omit credential fields and the request bearer. */
function traceValue(value: unknown, bearer: string | undefined): JsonValue {
  const encoded = JSON.stringify(value, (key, item) => {
    if (secretField.test(key.replace(/[-_.]/g, ""))) return "[redacted]"
    if (typeof item === "string" && bearer)
      return item.replaceAll(bearer, "[redacted]")
    return item
  })
  if (encoded === undefined) return null
  const bytes = Buffer.from(encoded)
  return bytes.byteLength > maxPayloadBytes
    ? {
        truncated: true,
        bytes: bytes.byteLength,
        preview: bytes.subarray(0, maxPayloadBytes).toString("utf8"),
      }
    : JSON.parse(encoded)
}

/** Recording failures must never turn a completed tool side effect into a retry. */
export async function traceMcpRequest(
  request: Request,
  body: unknown,
  attributes: JsonObject,
  action: () => Promise<Response>
) {
  const identity = workspaceIdentity()
  if (!identity) return action()
  const agentTraceId = await existingAgentMcpTrace(
    request,
    body,
    identity.projectId
  )
  if (agentTraceId) {
    // The agent owns the tool span, its result and failures. Do not count it twice.
    const response = await action()
    response.headers.set("X-Datool-Trace-Id", agentTraceId)
    return response
  }
  const message = body as {
    method?: unknown
    params?: { name?: unknown; arguments?: unknown }
  } | null
  const method =
    typeof message?.method === "string"
      ? message.method.slice(0, 200)
      : "unknown"
  const tool =
    method === "tools/call" && typeof message?.params?.name === "string"
      ? message.params.name.slice(0, 200)
      : undefined
  const startedAt = new Date().toISOString()
  let response: Response | undefined
  let failure: unknown
  try {
    response = await action()
    return response
  } catch (error) {
    failure = error
    throw error
  } finally {
    const endedAt = new Date().toISOString()
    try {
      const envelope = response?.headers
        .get("content-type")
        ?.includes("application/json")
        ? await response.clone().json()
        : null
      const failed =
        failure !== undefined ||
        (response?.status ?? 500) >= 400 ||
        Boolean(envelope?.error || envelope?.result?.isError)
      const bearer = request.headers
        .get("authorization")
        ?.replace(/^Bearer\s+/i, "")
      const input = traceValue(
        tool ? message?.params?.arguments : (message?.params ?? body),
        bearer
      )
      const output = traceValue(
        failure instanceof Error
          ? { error: failure.message }
          : (envelope?.result ?? envelope),
        bearer
      )
      const status = request.signal.aborted
        ? "cancelled"
        : failed
          ? "errored"
          : "completed"
      const traceAttributes: JsonObject = {
        "mcp.method": method,
        "mcp.tool.name": tool,
        "mcp.auth.type": identity.kind,
        "mcp.client.id": identity.clientId,
        "mcp.actor.id": identity.userId ?? identity.apiKeyId,
        "http.response.status_code": response?.status ?? 500,
        ...attributes,
      }
      const receipt = await runTracerEffect(
        (await getTracerService(identity.projectId)).createTraceReceipt({
          name: `MCP · ${tool ?? method}`,
          operation: `mcp.${method.replaceAll("/", ".")}`,
          startedAt,
          endedAt,
          status,
          input,
          output,
          attributes: traceAttributes,
          ...(tool
            ? {
                spans: [
                  {
                    name: tool,
                    kind: "tool" as const,
                    startedAt,
                    endedAt,
                    status,
                    input,
                    output,
                    attributes: traceAttributes,
                  },
                ],
              }
            : {}),
        })
      )
      response?.headers.set("X-Datool-Trace-Id", receipt.id)
    } catch {
      securityAudit({ action: "mcp.trace_failed" }, 500)
    }
  }
}
