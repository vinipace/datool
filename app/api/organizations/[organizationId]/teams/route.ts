import { drizzle } from "drizzle-orm/node-postgres"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { db } from "@/lib/db"
import { requireOrganizationRole } from "@/lib/project-access"
import { teamInputSchema } from "@/src/lib/build/contracts"
import { authApiError } from "@/src/server/auth/errors"
import {
  createOrganizationTeam,
  updateOrganizationTeam,
  listOrganizationTeams,
  listTeamCandidates,
} from "@/src/server/organization-teams"
import * as schema from "@/src/server/tracer/schema"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
type Context = { params: Promise<{ organizationId: string }> }
const database = drizzle(db, { schema })
const responseHeaders = { "Cache-Control": "no-store" }

export async function GET(request: Request, context: Context) {
  try {
    const { organizationId } = await context.params
    const access = await requireOrganizationRole(request, organizationId)
    if (access.kind !== "ok") return accessError(access.kind)
    const ctx = { database, organizationId }
    const [teams, members] = await Promise.all([
      listOrganizationTeams(ctx),
      listTeamCandidates(ctx),
    ])
    return Response.json(
      {
        teams,
        members,
        canManage: access.role === "owner" || access.role === "admin",
      },
      { headers: responseHeaders }
    )
  } catch (error) {
    return authApiError(error)
  }
}

async function save(request: Request, context: Context, update: boolean) {
  if (!hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const { organizationId } = await context.params
    const access = await requireOrganizationRole(request, organizationId, {
      manage: true,
    })
    if (access.kind !== "ok") return accessError(access.kind)
    const body = await readJson(request, 80_000)
    if (body.kind === "too-large")
      return apiError("PAYLOAD_TOO_LARGE", "Team request is too large.", 413)
    if (body.kind !== "ok")
      return apiError("VALIDATION_ERROR", "A JSON team is required.", 400)
    const ctx = { database, organizationId }
    if (update) {
      const { id, ...input } = teamInputSchema
        .partial()
        .extend({ id: z.string().min(1).max(128) })
        .strict()
        .parse(body.value)
      const team = await updateOrganizationTeam(ctx, id, input)
      return Response.json({ team }, { headers: responseHeaders })
    }
    const team = await createOrganizationTeam(ctx, body.value)
    return Response.json({ team }, { status: 201, headers: responseHeaders })
  } catch (error) {
    return authApiError(error)
  }
}

export function POST(request: Request, context: Context) {
  return save(request, context, false)
}
export function PATCH(request: Request, context: Context) {
  return save(request, context, true)
}
