import { NextResponse } from "next/server"

import { readJson } from "@/src/server/tracer/http"
import {
  assertPublicRequestOrigin,
  publicConnectionContext,
  publicRequestClientKey,
  publicServerOrigin,
  PublicAdmissionRateLimitError,
  recordPublicFeedback,
} from "@/src/server/build/channels/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ connectionId: string }> }

function requestOrigin(request: Request) {
  // The parent frame is authorized by CSP on the hosted chat page. A custom
  // caller header is advisory at most and must never change this origin.
  return request.headers.get("origin") ?? undefined
}

function sameOrigin(request: Request) {
  const configured = publicServerOrigin()
  if (configured) return configured
  try { return new URL(request.url).origin } catch { return undefined }
}

function visitorToken(request: Request, body: unknown) {
  const header = request.headers.get("x-datool-visitor-token")
  if (header) return header
  if (body && typeof body === "object" && typeof (body as { visitorToken?: unknown }).visitorToken === "string")
    return (body as { visitorToken: string }).visitorToken
  return ""
}

function responseWithOrigin(body: unknown, status = 200, extraHeaders?: HeadersInit, allowedOrigin?: string) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
      ...(extraHeaders ?? {}),
    },
  })
}

export async function POST(request: Request, context: Context) {
  let body: unknown
  try { body = await readJson(request) } catch { return responseWithOrigin({ error: { message: "Request body is invalid." } }, 400) }
  let allowedOrigin: string | undefined
  try {
    const { connectionId } = await context.params
    const requestOriginValue = requestOrigin(request)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(connectionId, requestOriginValue ?? null, requestServerOrigin)
    const input = body && typeof body === "object"
      ? body as { conversationId?: unknown; messageId?: unknown; question?: unknown; sentiment?: unknown; reason?: unknown }
      : {}
    if (typeof input.conversationId !== "string" || !input.conversationId.trim())
      return responseWithOrigin({ error: { message: "conversationId is required." } }, 400, undefined, allowedOrigin)
    if (typeof input.question !== "string" || !input.question.trim() || input.question.length > 4_000)
      return responseWithOrigin({ error: { message: "question is required and must be bounded." } }, 400, undefined, allowedOrigin)
    if (input.sentiment !== "positive" && input.sentiment !== "negative" && input.sentiment !== "unknown")
      return responseWithOrigin({ error: { message: "sentiment is invalid." } }, 400, undefined, allowedOrigin)
    if (input.reason !== undefined && typeof input.reason !== "string")
      return responseWithOrigin({ error: { message: "reason must be text." } }, 400, undefined, allowedOrigin)
    if (input.messageId !== undefined && (typeof input.messageId !== "string" || !input.messageId.trim() || input.messageId.length > 256))
      return responseWithOrigin({ error: { message: "messageId must be a valid message identifier." } }, 400, undefined, allowedOrigin)
    const build = await publicConnectionContext(connectionId)
    const data = await recordPublicFeedback(build, connectionId, input.conversationId, visitorToken(request, body), {
      question: input.question,
      messageId: input.messageId,
      sentiment: input.sentiment,
      reason: input.reason,
      origin: requestOriginValue,
      sameOrigin: requestServerOrigin,
      clientKey: publicRequestClientKey(request),
    })
    return responseWithOrigin({ data }, 200, undefined, allowedOrigin)
  } catch (error) {
    if (error instanceof PublicAdmissionRateLimitError) {
      return responseWithOrigin({ error: { message: error.message } }, 429, { "Retry-After": String(error.retryAfterSeconds) }, allowedOrigin)
    }
    const message = error instanceof Error ? error.message : "Feedback could not be recorded."
    const expected = /^(Channel connection is not connected\.|This public deployment|This channel is not enabled|Origin must be|Invalid visitor|Visitor context|Conversation is not available|Message is not available)/i.test(message)
    return responseWithOrigin({ error: { message: expected ? message : "Feedback could not be recorded." } }, expected ? (/visitor|context|available|expired|invalid/i.test(message) ? 401 : 400) : 503, undefined, allowedOrigin)
  }
}

export async function OPTIONS(request: Request, context: Context) {
  const requested = request.headers.get("origin")
  let allowed: string | undefined
  if (requested) {
    try {
      const { connectionId } = await context.params
      allowed = await assertPublicRequestOrigin(connectionId, requested, sameOrigin(request))
    } catch {
      return new Response(null, { status: 403 })
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...(allowed ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" } : {}),
      "Access-Control-Allow-Headers": "content-type, x-datool-visitor-token, x-datool-embed-origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    },
  })
}
