import { authApiError } from "@/src/server/auth/errors"
import { z } from "zod"
import { db } from "@/lib/db"
import { readJson } from "@/src/server/tracer/http"
import {
  createOrganizationKey,
  keyAccess,
  listOrganizationKeys,
} from "@/src/server/auth/key-management"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
type Context = { params: Promise<{ organizationId: string }> }
export async function GET(request: Request, context: Context) {
  try {
    return Response.json(
      {
        data: await listOrganizationKeys(
          request,
          (await context.params).organizationId
        ),
      },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
export async function POST(request: Request, context: Context) {
  try {
    return Response.json(
      {
        data: await createOrganizationKey(
          request,
          (await context.params).organizationId,
          await readJson(request)
        ),
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    return authApiError(error)
  }
}
export async function PATCH(request: Request, context: Context) {
  try {
    const { organizationId } = await context.params
    await keyAccess(request, organizationId, true)
    const { creationDisabled } = z
      .object({ creationDisabled: z.boolean() })
      .strict()
      .parse(await readJson(request))
    await db.query(
      `INSERT INTO organization_key_policy (organization_id, creation_disabled) VALUES ($1, $2)
      ON CONFLICT (organization_id) DO UPDATE SET creation_disabled = EXCLUDED.creation_disabled`,
      [organizationId, creationDisabled]
    )
    return Response.json({ data: { creationDisabled } })
  } catch (error) {
    return authApiError(error)
  }
}
