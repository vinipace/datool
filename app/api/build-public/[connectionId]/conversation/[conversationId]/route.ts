import { NextResponse } from "next/server"

import { readJson } from "@/src/server/tracer/http"
import {
  assertPublicRequestOrigin,
  enqueuePublicMessage,
  publicConnectionContext,
  publicRequestClientKey,
  publicServerOrigin,
  PublicAdmissionRateLimitError,
  readPublicConversation,
  resetPublicConversation,
} from "@/src/server/build/channels/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

type Context = { params: Promise<{ connectionId: string; conversationId: string }> }

function requestOrigin(request: Request) {
  // Parent-frame origin is enforced by CSP on /chat/:connectionId. Never use
  // a caller-supplied header as an authorization signal for API access.
  return request.headers.get("origin") ?? undefined
}

function sameOrigin(request: Request) {
  const configured = publicServerOrigin()
  if (configured) return configured
  try { return new URL(request.url).origin } catch { return undefined }
}

function visitorToken(request: Request, body?: unknown) {
  const header = request.headers.get("x-datool-visitor-token")
  if (header) return header
  if (body && typeof body === "object" && typeof (body as { visitorToken?: unknown }).visitorToken === "string")
    return (body as { visitorToken: string }).visitorToken
  return ""
}

function responseWithOrigin(body: unknown, init?: ResponseInit, allowedOrigin?: string) {
  return NextResponse.json(body, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" } : {}),
      ...(init?.headers ?? {}),
    },
  })
}

export async function GET(request: Request, context: Context) {
  let allowedOrigin: string | undefined
  try {
    const { connectionId, conversationId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(connectionId, requestOrigin(request) ?? null, requestServerOrigin)
    const token = visitorToken(request)
    if (!token) return responseWithOrigin({ error: { message: "A visitor token is required." } }, { status: 401 }, allowedOrigin)
    const data = await readPublicConversation(build, connectionId, conversationId, token, requestOrigin(request), requestServerOrigin)
    return responseWithOrigin({ data }, undefined, allowedOrigin)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not read the conversation."
    const expected = /^(Channel connection is not connected\.|This public deployment|This channel is not enabled|Origin must be|Invalid visitor|Visitor context|Conversation is not available|Conversation is closed)/i.test(message)
    return responseWithOrigin({ error: { message: expected ? message : "Could not read the conversation." } }, { status: /expired|invalid visitor|not available/i.test(message) ? 401 : expected ? 400 : 503 }, allowedOrigin)
  }
}

export async function POST(request: Request, context: Context) {
  let body: unknown
  try { body = await readJson(request) } catch { return responseWithOrigin({ error: { message: "Request body is invalid." } }, { status: 400 }) }
  let allowedOrigin: string | undefined
  try {
    const { connectionId, conversationId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const requestOriginValue = requestOrigin(request)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(connectionId, requestOriginValue ?? null, requestServerOrigin)
    const input = body && typeof body === "object" ? body as { text?: unknown; attachments?: unknown; visitorToken?: unknown; idempotencyKey?: unknown; metadata?: Record<string, unknown> } : {}
    if (typeof input.text !== "string" || input.text.trim().length === 0 || input.text.length > 100_000)
      return responseWithOrigin({ error: { message: "Message text is required and must be bounded." } }, { status: 400 }, allowedOrigin)
    const result = await enqueuePublicMessage(build, connectionId, conversationId, visitorToken(request, body), {
      text: input.text,
      attachments: Array.isArray(input.attachments) ? input.attachments as never[] : [],
      metadata: input.metadata,
      origin: requestOriginValue,
      sameOrigin: requestServerOrigin,
      clientKey: publicRequestClientKey(request),
      ...(typeof input.idempotencyKey === "string" ? { idempotencyKey: input.idempotencyKey } : {}),
    })
    // Human ownership suppresses the AI worker after durable admission; it
    // does not reject the visitor's message or turn a duplicate into a 409.
    return responseWithOrigin({ data: result }, { status: 202 }, allowedOrigin)
  } catch (error) {
    if (error instanceof PublicAdmissionRateLimitError) {
      return responseWithOrigin({ error: { message: error.message } }, {
        status: 429,
        headers: { "Retry-After": String(error.retryAfterSeconds) },
      }, allowedOrigin)
    }
    const message = error instanceof Error ? error.message : "Could not accept the message."
    const expected = /^(Channel connection is not connected\.|This public deployment|This channel is not enabled|Origin must be|Invalid visitor|Visitor context|Conversation is not available|Conversation is closed)/i.test(message)
    return responseWithOrigin({ error: { message: expected ? message : "Could not accept the message." } }, { status: /expired|invalid visitor|not available/i.test(message) ? 401 : expected ? 400 : 503 }, allowedOrigin)
  }
}

export async function DELETE(request: Request, context: Context) {
  let allowedOrigin: string | undefined
  try {
    const { connectionId, conversationId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const requestOriginValue = requestOrigin(request)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(connectionId, requestOriginValue ?? null, requestServerOrigin)
    const result = await resetPublicConversation(build, connectionId, conversationId, visitorToken(request), requestOriginValue, requestServerOrigin)
    return responseWithOrigin({ data: result }, undefined, allowedOrigin)
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not reset the conversation."
    const expected = /^(Channel connection is not connected\.|This public deployment|This channel is not enabled|Origin must be|Invalid visitor|Visitor context|Conversation is not available)/i.test(message)
    return responseWithOrigin({ error: { message: expected ? message : "Could not reset the conversation." } }, { status: expected ? 400 : 503 }, allowedOrigin)
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
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Max-Age": "600",
    },
  })
}
