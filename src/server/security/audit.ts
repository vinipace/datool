import { workspaceIdentity } from "@/src/server/auth/context"

type AuditIdentity = {
  actorType: "session" | "api-key" | "oauth" | "system" | "visitor" | "unknown"
  actorId?: string
  clientId?: string
  organizationId?: string
  projectId?: string
}

type AuditDetails = {
  /** Static label or a name selected from a registered operation catalog. Never input. */
  action: string
  identity?: AuditIdentity
  /** Opaque identifiers only; never tokens, names, addresses or request keys. */
  targetId?: string
  connectionId?: string
  conversationId?: string
  role?: string
}

export function workspaceAuditIdentity(): AuditIdentity {
  const identity = workspaceIdentity()
  return {
    actorType: identity?.kind ?? "unknown",
    actorId:
      identity?.kind === "api-key" ? identity.apiKeyId : identity?.userId,
    clientId: identity?.clientId,
    organizationId: identity?.organizationId,
    projectId: identity?.projectId,
  }
}

const identifier = (value: unknown) =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value)
    ? value
    : undefined
const statusCode = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 100 &&
  value <= 599
    ? value
    : undefined

/** One bounded metadata-only record, forwarded by the existing application log collector. */
export function securityAudit(
  details: AuditDetails,
  status = 200,
  durationMs?: number,
) {
  try {
    const identity = details.identity ?? workspaceAuditIdentity()
    const code = statusCode(status) ?? 500
    console.info(
      JSON.stringify({
        event: "security_audit",
        version: 1,
        eventId: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        action: /^[A-Za-z0-9_.-]{1,140}$/.test(details.action)
          ? details.action
          : "unknown",
        outcome:
          code === 401 || code === 403
            ? "denied"
            : code >= 400
              ? "error"
              : "success",
        status: code,
        actorType: identity.actorType,
        actorId: identifier(identity.actorId),
        clientId: identifier(identity.clientId),
        organizationId: identifier(identity.organizationId),
        projectId: identifier(identity.projectId),
        targetId: identifier(details.targetId),
        connectionId: identifier(details.connectionId),
        conversationId: identifier(details.conversationId),
        role:
          details.role && ["owner", "admin", "member"].includes(details.role)
            ? details.role
            : undefined,
        durationMs:
          durationMs === undefined
            ? undefined
            : Math.max(0, Math.round(durationMs)),
      }),
    )
  } catch {
    // A broken log sink must not fail a completed action and cause a merchant
    // or channel worker to retry it. Collector health is an operator concern.
  }
}

export async function audited<T>(
  details: AuditDetails,
  action: () => T | Promise<T>,
): Promise<T> {
  const started = performance.now()
  // Capture the initiating principal, not an identity changed inside the action.
  const event = {
    ...details,
    identity: details.identity ?? workspaceAuditIdentity(),
  }
  try {
    const result = await action()
    securityAudit(
      event,
      result instanceof Response ? result.status : 200,
      performance.now() - started,
    )
    return result
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? statusCode(error.status)
        : undefined
    securityAudit(event, status ?? 500, performance.now() - started)
    throw error
  }
}
