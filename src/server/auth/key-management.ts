import { getAuth } from "@/lib/auth"
import { db } from "@/lib/db"
import { requireOrganizationRole } from "@/lib/project-access"
import { TracerError } from "@/src/server/tracer/errors"
import {
  isOrganizationAdmin,
  permissionStatements,
  workspaceScopes,
} from "@/src/lib/auth/permissions"
import { assertSameOrigin } from "./request"
import { z } from "zod"
export const createKeySchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    scopes: z
      .array(z.enum(workspaceScopes))
      .min(1)
      .max(workspaceScopes.length)
      .default(["traces:write"]),
    expiresIn: z.number().int().min(86400).max(31536000).nullable().default(7776000),
  })
  .strict()
export async function keyAccess(
  request: Request,
  organizationId: string,
  manage = false
) {
  if (manage) assertSameOrigin(request)
  const access = await requireOrganizationRole(request, organizationId, {
    manage,
  })
  if (access.kind !== "ok")
    throw new TracerError(
      "UNAUTHORIZED",
      access.kind === "unauthenticated"
        ? "Sign in first."
        : "Organization permission required.",
      { status: access.kind === "unauthenticated" ? 401 : 403 }
    )
  return access
}
export async function listOrganizationKeys(
  request: Request,
  organizationId: string
) {
  const access = await keyAccess(request, organizationId)
  const policy = await db.query<{ creation_disabled: boolean }>(
    "SELECT creation_disabled FROM organization_key_policy WHERE organization_id = $1",
    [organizationId]
  )
  const canManage = isOrganizationAdmin(access.role)
  // Project members can see policy, but key inventory is reserved for managers.
  const query = new URL(request.url).searchParams
  const limit = z.coerce
    .number()
    .int()
    .min(1)
    .max(100)
    .parse(query.get("limit") ?? 100)
  const offset = z.coerce
    .number()
    .int()
    .min(0)
    .parse(query.get("offset") ?? 0)
  const result = canManage
    ? await getAuth().api.listApiKeys({
        headers: request.headers,
        query: { organizationId, limit, offset },
      })
    : null
  const keys = (result?.apiKeys ?? []).map((key) => ({
    id: key.id,
    name: key.name,
    start: key.start,
    prefix: key.prefix,
    createdAt: key.createdAt,
    expiresAt: key.expiresAt,
    enabled: key.enabled,
    permissions: key.permissions,
    scopes: Object.entries(key.permissions ?? {}).flatMap(
      ([resource, actions]) => actions.map((action) => `${resource}:${action}`)
    ),
    createdBy:
      typeof key.metadata?.createdBy === "string"
        ? key.metadata.createdBy
        : null,
  }))
  return {
    keys,
    canManage,
    creationDisabled: policy.rows[0]?.creation_disabled ?? false,
    total: result?.total ?? 0,
    limit,
    offset,
  }
}
export async function createOrganizationKey(
  request: Request,
  organizationId: string,
  input: unknown
) {
  const access = await keyAccess(request, organizationId, true)
  const body = createKeySchema.parse(input)
  const session = await getAuth().api.getSession({ headers: request.headers })
  // Membership and manager role were checked above. Permission assignment is a
  // server-only plugin operation; forwarding browser headers makes it reject it.
  const key = await getAuth().api.createApiKey({
    body: {
      organizationId,
      userId: access.userId,
      name: body.name,
      expiresIn: body.expiresIn,
      permissions: permissionStatements(body.scopes),
      metadata: {
        createdBy: session?.user.name ?? access.userId,
        createdByUserId: access.userId,
      },
    },
  })
  return { id: key.id, key: key.key }
}
export async function revokeOrganizationKey(
  request: Request,
  organizationId: string,
  keyId: string
) {
  await keyAccess(request, organizationId, true)
  const key = await getAuth().api.getApiKey({
    headers: request.headers,
    query: { id: keyId },
  })
  if (key.referenceId !== organizationId)
    throw new TracerError(
      "UNAUTHORIZED",
      "Key belongs to another organization.",
      { status: 403 }
    )
  await getAuth().api.deleteApiKey({
    headers: request.headers,
    body: { keyId },
  })
  return { revoked: true }
}
