import { NextResponse } from "next/server"
import { resolveBubbleLauncher } from "@/src/lib/build/bubble-localization"
import {
  getPublicChatAppearance,
  publicConnectionContext,
  publicServerOrigin,
} from "@/src/server/build/channels/service"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ connectionId: string }> }
) {
  try {
    const { connectionId } = await params
    const context = await publicConnectionContext(connectionId)
    const { appearance, allowedOrigin } = await getPublicChatAppearance(
      context,
      connectionId,
      request.headers.get("origin"),
      publicServerOrigin() || new URL(request.url).origin
    )
    return NextResponse.json(
      {
        data: {
          appearance,
          launcher: resolveBubbleLauncher(
            appearance,
            request.headers.get("accept-language") ?? "en"
          ),
        },
      },
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
      { error: { message: "This chat bubble is unavailable." } },
      { status: 404, headers: { "Cache-Control": "no-store" } }
    )
  }
}
