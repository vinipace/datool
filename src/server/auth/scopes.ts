import type { WorkspaceScope } from "@/src/lib/auth/permissions"
import { TracerError } from "@/src/server/tracer/errors"

/** Permission checks used by both HTTP handlers and standalone execution workers. */
export function requireScopes(granted: readonly string[], required: readonly WorkspaceScope[]) {
  const missingScopes = required.filter(scope => !granted.includes(scope))
  if (missingScopes.length) throw new TracerError("UNAUTHORIZED", `Missing required permission: ${missingScopes.join(", ")}.`, {
    status: 403, details: { reason: "INSUFFICIENT_SCOPE", missingScopes },
  })
}
