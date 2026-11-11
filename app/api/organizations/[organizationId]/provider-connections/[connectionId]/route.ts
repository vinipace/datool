import { NextResponse } from "next/server"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireOrganizationRole } from "@/lib/project-access"
import { organizationProviderContext } from "@/src/server/providers/context"
import {
  changeConnection,
  ProviderConnectionError,
} from "@/src/server/providers/connections"
export const runtime = "nodejs"
export async function PATCH(
  request: Request,
  context: { params: Promise<{ organizationId: string; connectionId: string }> }
) {
  if (!hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const { organizationId, connectionId } = await context.params
    const access = await requireOrganizationRole(request, organizationId, {
      manage: true,
    })
    if (access.kind !== "ok") return accessError(access.kind)
    const body = await readJson(request, 4096)
    if (body.kind === "too-large")
      return apiError(
        "PAYLOAD_TOO_LARGE",
        "Provider request is too large.",
        413
      )
    const parsed = z
      .object({
        kind: z.enum(["model", "sandbox"]),
        action: z.enum(["default", "inherit"]),
      })
      .strict()
      .parse(body.kind === "ok" ? body.value : null)
    await changeConnection(
      organizationProviderContext(organizationId),
      parsed.kind,
      z.uuid().parse(connectionId),
      parsed.action
    )
    return NextResponse.json(
      { updated: true },
      { headers: { "Cache-Control": "no-store" } }
    )
  } catch (error) {
    if (error instanceof ProviderConnectionError)
      return apiError("VALIDATION_ERROR", error.message, 400)
    if (error instanceof z.ZodError)
      return apiError(
        "VALIDATION_ERROR",
        "Choose a valid provider connection and action.",
        400
      )
    return apiError(
      "INTERNAL_ERROR",
      "Unable to update provider connection.",
      500
    )
  }
}
