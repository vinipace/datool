import { NextResponse } from "next/server"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import {
  sandboxProviderIdSchema,
  sandboxProviderInputSchema,
} from "@/src/lib/sandbox-providers"
import {
  getSandboxProviderSettings,
  SandboxSettingsValidationError,
  updateSandboxProviderSettings,
} from "@/src/server/sandbox/providers-store"

export const runtime = "nodejs"
type Context = { params: Promise<{ projectId: string }> }
const providerSchema = z.object({ provider: sandboxProviderIdSchema }).strict()
const json = (value: unknown) =>
  NextResponse.json(value, { headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    return json(await getSandboxProviderSettings(projectId))
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
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId, {
      manage: true,
    })
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
      const parsed = sandboxProviderInputSchema.safeParse(value)
      if (!parsed.success)
        return apiError(
          "VALIDATION_ERROR",
          "Provide valid sandbox provider settings.",
          400
        )
      await updateSandboxProviderSettings(projectId, {
        type,
        input: parsed.data,
      })
    } else {
      const parsed = providerSchema.safeParse(value)
      if (!parsed.success)
        return apiError(
          "VALIDATION_ERROR",
          "Choose a supported sandbox provider.",
          400
        )
      await updateSandboxProviderSettings(projectId, {
        type,
        provider: parsed.data.provider,
      })
    }
    return json(await getSandboxProviderSettings(projectId))
  } catch (error) {
    if (error instanceof SandboxSettingsValidationError)
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
