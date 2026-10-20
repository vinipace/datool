import { NextResponse } from "next/server"

import { readJson } from "@/src/server/tracer/http"
import {
  createPublicSession,
  listPublicConversations,
  assertPublicRequestOrigin,
  publicConnectionContext,
  publicRequestClientKey,
  publicServerOrigin,
  PublicAdmissionRateLimitError,
} from "@/src/server/build/channels/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

type Context = { params: Promise<{ connectionId: string }> }

function origin(request: Request) {
  // The parent page cannot prove its identity with a caller-supplied header.
  // Hosted iframe requests use the Datool origin; CSP frame-ancestors is the
  // browser-enforced parent-origin boundary.
  return request.headers.get("origin") ?? null
}

function sameOrigin(request: Request) {
  const configured = publicServerOrigin()
  if (configured) return configured
  try {
    return new URL(request.url).origin
  } catch {
    return undefined
  }
}

export async function POST(request: Request, context: Context) {
  let allowedOrigin: string | undefined
  try {
    const { connectionId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const requestOrigin = origin(request)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(
      connectionId,
      requestOrigin,
      requestServerOrigin
    )
    const body = await readJson(request)
    const input =
      body && typeof body === "object"
        ? (body as {
            visitorToken?: string
            conversationId?: string
            context?: Record<string, unknown>
          })
        : {}
    const result = await createPublicSession(build, connectionId, {
      visitorToken: input.visitorToken,
      conversationId:
        typeof input.conversationId === "string"
          ? input.conversationId.slice(0, 200)
          : undefined,
      origin: requestOrigin ?? undefined,
      sameOrigin: requestServerOrigin,
      context: input.context,
      clientKey: publicRequestClientKey(request),
    })
    return NextResponse.json(
      { data: result },
      {
        headers: {
          "Cache-Control": "no-store",
          ...(allowedOrigin
            ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
            : {}),
        },
      }
    )
  } catch (error) {
    if (error instanceof PublicAdmissionRateLimitError) {
      return NextResponse.json(
        { error: { message: error.message } },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(error.retryAfterSeconds),
            ...(allowedOrigin
              ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
              : {}),
          },
        }
      )
    }
    const message =
      error instanceof Error
        ? error.message
        : "Could not create a public session."
    const expected =
      /^(Channel connection is not connected\.|This public deployment|This channel is not enabled|Origin must be|Invalid visitor|Visitor context|Conversation is not available)/i.test(
        message
      )
    return NextResponse.json(
      {
        error: {
          message: expected ? message : "Could not create a public session.",
        },
      },
      {
        status: /not found/i.test(message)
          ? 404
          : expected
            ? /visitor|context/i.test(message)
              ? 401
              : 400
            : 503,
        headers: {
          "Cache-Control": "no-store",
          ...(allowedOrigin
            ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
            : {}),
        },
      }
    )
  }
}

export async function GET(request: Request, context: Context) {
  let allowedOrigin: string | undefined
  try {
    const { connectionId } = await context.params
    const build = await publicConnectionContext(connectionId)
    const requestOrigin = origin(request)
    const requestServerOrigin = sameOrigin(request)
    allowedOrigin = await assertPublicRequestOrigin(
      connectionId,
      requestOrigin,
      requestServerOrigin
    )
    const token = request.headers.get("x-datool-visitor-token")
    if (!token)
      return NextResponse.json(
        { error: { message: "A visitor token is required." } },
        { status: 401 }
      )
    const data = await listPublicConversations(
      build,
      connectionId,
      token,
      requestOrigin ?? undefined,
      requestServerOrigin
    )
    return NextResponse.json(
      { data },
      {
        headers: {
          "Cache-Control": "no-store",
          ...(allowedOrigin
            ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
            : {}),
        },
      }
    )
  } catch {
    return NextResponse.json(
      {
        error: {
          message:
            "Conversation history is unavailable. Please reload and try again.",
        },
      },
      {
        status: 401,
        headers: {
          "Cache-Control": "no-store",
          ...(allowedOrigin
            ? { "Access-Control-Allow-Origin": allowedOrigin, Vary: "Origin" }
            : {}),
        },
      }
    )
  }
}

export async function OPTIONS(request: Request, context: Context) {
  const requested = request.headers.get("origin")
  let allowed: string | undefined
  if (requested) {
    try {
      const { connectionId } = await context.params
      allowed = await assertPublicRequestOrigin(
        connectionId,
        requested,
        sameOrigin(request)
      )
    } catch {
      return new Response(null, { status: 403 })
    }
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...(allowed
        ? { "Access-Control-Allow-Origin": allowed, Vary: "Origin" }
        : {}),
      "Access-Control-Allow-Headers":
        "content-type, x-datool-visitor-token, x-datool-embed-origin",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Max-Age": "600",
    },
  })
}
