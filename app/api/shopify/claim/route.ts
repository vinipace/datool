import { z } from "zod"
import { db } from "@/lib/db"
import { getAuth } from "@/lib/auth"
import {
  accessError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { TracerError } from "@/src/server/tracer/errors"
import { claimShopifyInstall } from "@/src/server/build/integrations/shopify-install"
export const runtime = "nodejs"
export async function POST(request: Request) {
  if (!hasTrustedMutationOrigin(request)) return accessError("forbidden")
  const session = await getAuth().api.getSession({ headers: request.headers })
  if (!session?.user.id) return accessError("unauthenticated")
  try {
    const input = await readJson(request, 4096)
    const body = z
      .object({
        organizationId: z.string().min(1).max(128),
        projectId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .parse(input.kind === "ok" ? input.value : null)
    const result = await claimShopifyInstall(
      db,
      request,
      session.user.id,
      body.organizationId,
      body.projectId
    )
    return Response.json(result, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return Response.json(
      {
        error: {
          message:
            error instanceof TracerError
              ? error.message
              : "Shopify could not be connected. Please try again.",
        },
      },
      {
        status: error instanceof TracerError ? error.status : 400,
        headers: { "Cache-Control": "no-store" },
      }
    )
  }
}
