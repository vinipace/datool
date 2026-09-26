import { NextResponse } from "next/server"
import { z } from "zod"
import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { MODEL_PROVIDER_IDS } from "@/src/lib/model-providers"
import {
  getProjectProviders,
  removeProjectProviderKey,
  saveProjectProviderKey,
} from "@/src/server/model-providers/store"

export const runtime = "nodejs"
type Context = { params: Promise<{ projectId: string }> }
const inputSchema = z
  .object({
    provider: z.enum(MODEL_PROVIDER_IDS).refine((id) => id !== "datool"),
    apiKey: z.string().trim().min(1).max(4096).regex(/^\S+$/).optional(),
  })
  .strict()
const json = (value: unknown) =>
  NextResponse.json(value, { headers: { "Cache-Control": "no-store" } })

export async function GET(request: Request, context: Context) {
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId)
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    return json({ providers: await getProjectProviders(projectId) })
  } catch {
    return apiError("INTERNAL_ERROR", "Unable to load model providers.", 500)
  }
}

async function mutate(request: Request, context: Context, remove: boolean) {
  if (!hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const { projectId } = await context.params
    const authorization = await requireProjectAccess(request, projectId, {
      manage: true,
    })
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
    if (remove) await removeProjectProviderKey(projectId, parsed.data.provider)
    else
      await saveProjectProviderKey(
        projectId,
        parsed.data.provider,
        parsed.data.apiKey!
      )
    return json({ providers: await getProjectProviders(projectId) })
  } catch {
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
