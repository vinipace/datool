import { NextResponse } from "next/server"

import { readJson } from "@/src/server/tracer/http"
import {
  enqueueTelegramUpdate,
  publicConnectionContext,
  verifyTelegramWebhookSecret,
} from "@/src/server/build/channels/service"
import type { TelegramUpdate } from "@/src/server/build/channels/telegram"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30

type Context = { params: Promise<{ connectionId: string }> }

/** Telegram retries a webhook when this handler does not return a 2xx. */
export async function POST(request: Request, context: Context) {
  const { connectionId } = await context.params
  try {
    const build = await publicConnectionContext(connectionId)
    const supplied = request.headers.get("x-telegram-bot-api-secret-token")
    if (!(await verifyTelegramWebhookSecret(build, connectionId, supplied))) {
      return NextResponse.json({ error: { message: "Webhook authentication failed." } }, { status: 401 })
    }
    const update = await readJson(request) as TelegramUpdate
    if (!update || typeof update !== "object" || !Number.isSafeInteger(update.update_id))
      return NextResponse.json({ error: { message: "Telegram update is invalid." } }, { status: 400 })
    const result = await enqueueTelegramUpdate(build, connectionId, update)
    return NextResponse.json({ ok: true, data: result }, { status: 200, headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    // Do not include provider responses, credentials or update bodies in the
    // public error. Telegram retries only when the request could not be
    // durably admitted; authentication and malformed updates are permanent.
    const message = error instanceof Error ? error.message : "Webhook could not be accepted."
    const status = /not found/i.test(message) ? 404 : /invalid|authentication|secret/i.test(message) ? 400 : 503
    return NextResponse.json({ error: { message: status === 503 ? "Webhook admission is temporarily unavailable." : message } }, { status })
  }
}

export async function GET() {
  return NextResponse.json({ error: { message: "Telegram webhooks accept POST only." } }, { status: 405 })
}
