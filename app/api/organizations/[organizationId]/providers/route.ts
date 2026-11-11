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
import { MODEL_PROVIDER_IDS } from "@/src/lib/model-providers"
import {
  getOrganizationProviders,
  removeOrganizationProviderKey,
  saveOrganizationProviderKey,
} from "@/src/server/model-providers/store"

export const runtime = "nodejs"
type Context = { params: Promise<{ organizationId: string }> }
const inputSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDER_IDS).refine((id) => id !== "datool"),
    connectionId: z.uuid().optional(),
    apiKey: z.string().trim().min(1).max(4096).regex(/^\S+$/).optional(),
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
      await getOrganizationProviders(
        organizationProviderContext(organizationId)
      )
    )
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load model providers.", 500)
  }
}

async function mutate(request: Request, context: Context, remove: boolean) {
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
    const body = await readJson(request, 8192)
    if (body.kind === "too-large")
      return apiError(
        "PAYLOAD_TOO_LARGE",
        "Provider request is too large.",
        413
      )
    const parsed = inputSchema.safeParse(body.kind === "ok" ? body.value : null)
    if (!parsed.success || (!remove && !parsed.data.apiKey))
      return apiError(
        "VALIDATION_ERROR",
        "Choose a supported AI provider and provide a valid API key.",
        400
      )
    if (remove)
      await removeOrganizationProviderKey(
        organizationProviderContext(organizationId),
        parsed.data.provider,
        parsed.data.connectionId
      )
    else
      await saveOrganizationProviderKey(
        organizationProviderContext(organizationId),
        parsed.data.provider,
        parsed.data.apiKey!,
        parsed.data.connectionId
      )
    return json(
      await getOrganizationProviders(
        organizationProviderContext(organizationId)
      )
    )
  } catch (error) {
    if (error instanceof ProviderConnectionError)
      return apiError("VALIDATION_ERROR", error.message, 400)
    // Never serialize request data, database errors, or ciphertext.
    return apiError(
      "INTERNAL_ERROR",
      "Unable to update model provider settings.",
      500
    )
  }
}

export const PUT = (request: Request, context: Context) =>
  mutate(request, context, false)
export const DELETE = (request: Request, context: Context) =>
  mutate(request, context, true)
