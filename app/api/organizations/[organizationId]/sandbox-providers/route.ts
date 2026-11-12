import { organizationProviderContext } from "@/src/server/providers/context"
import { ProviderConnectionError } from "@/src/server/providers/connections"
import { NextResponse } from "next/server"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireOrganizationRole } from "@/lib/project-access"
import {
  sandboxProviderIdSchema,
  sandboxProviderInputSchema,
} from "@/src/lib/sandbox-providers"
import {
  getOrganizationSandboxSettings,
  updateOrganizationSandboxSettings,
} from "@/src/server/sandbox/providers-store"

export const runtime = "nodejs"
type Context = { params: Promise<{ organizationId: string }> }
const providerSchema = z
  .object({
    provider: sandboxProviderIdSchema,
    connectionId: z.uuid().optional(),
  })
  .strict()
const json = (value: unknown) =>
  NextResponse.json(value, { headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request, context: Context) {
  try {
    const { organizationId } = await context.params
    const authorization = await requireOrganizationRole(request, organizationId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    return json(
      await getOrganizationSandboxSettings(
        organizationProviderContext(organizationId)
      )
    )
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load sandbox providers.", 500)
  }
}

async function mutate(
  request: Request,
  context: Context,
  type: "configure" | "default" | "remove"
) {
  if (!hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const { organizationId } = await context.params
    const authorization = await requireOrganizationRole(
      request,
      organizationId,
      {
        manage: true,
      }
    )
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    const body = await readJson(request, 16384)
    if (body.kind === "too-large")
      return apiError(
        "PAYLOAD_TOO_LARGE",
        "Provider request is too large.",
        413
      )
    const value = body.kind === "ok" ? body.value : null
    if (type === "configure") {
      const parsed = z
        .object({ connectionId: z.uuid().optional() })
        .passthrough()
        .transform(({ connectionId, ...input }, ctx) => {
          const parsed = sandboxProviderInputSchema.safeParse(input)
          if (!parsed.success) {
            ctx.addIssue({
              code: "custom",
              message: "Invalid provider settings",
            })
            return z.NEVER
          }
          return { input: parsed.data, connectionId }
        })
        .safeParse(value)
      if (!parsed.success)
        return apiError(
          "VALIDATION_ERROR",
          "Provide valid sandbox provider settings.",
          400
        )
      await updateOrganizationSandboxSettings(
        organizationProviderContext(organizationId),
        {
          type,
          input: parsed.data.input,
          connectionId: parsed.data.connectionId,
        }
      )
    } else {
      const parsed = providerSchema.safeParse(value)
      if (!parsed.success)
        return apiError(
          "VALIDATION_ERROR",
          "Choose a supported sandbox provider.",
          400
        )
      await updateOrganizationSandboxSettings(
        organizationProviderContext(organizationId),
        {
          type,
          provider: parsed.data.provider,
          connectionId: parsed.data.connectionId,
        }
      )
    }
    return json(
      await getOrganizationSandboxSettings(
        organizationProviderContext(organizationId)
      )
    )
  } catch (error) {
    if (error instanceof ProviderConnectionError)
      return apiError("VALIDATION_ERROR", error.message, 400)
    return apiError(
      "INTERNAL_ERROR",
      "Unable to update sandbox provider settings.",
      500
    )
  }
}
export const PUT = (request: Request, context: Context) =>
  mutate(request, context, "configure")
export const PATCH = (request: Request, context: Context) =>
  mutate(request, context, "default")
export const DELETE = (request: Request, context: Context) =>
  mutate(request, context, "remove")
