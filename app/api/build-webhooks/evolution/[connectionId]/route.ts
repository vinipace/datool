import { NextResponse } from "next/server"
import { readJson } from "@/src/server/tracer/http"
import { publicConnectionContext } from "@/src/server/build/channels/service"
import { ingestEvolutionWebhook } from "@/src/server/build/channels/evolution"
import { TracerError } from "@/src/server/tracer/errors"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30
export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> }
) {
  const headers = { "Cache-Control": "no-store" }
  try {
    const { connectionId } = await context.params
    if (!/^[0-9a-f-]{36}$/i.test(connectionId))
      return NextResponse.json(
        { error: "Invalid connection." },
        { status: 400, headers }
      )
    const supplied = request.headers.get("x-datool-evolution-secret")
    if (!supplied || supplied.length > 128)
      return NextResponse.json(
        { error: "Unauthorized." },
        { status: 401, headers }
      )
    const build = await publicConnectionContext(connectionId)
    await ingestEvolutionWebhook(
      build,
      connectionId,
      supplied,
      await readJson(request, 256 * 1024)
    )
    return NextResponse.json({ ok: true }, { headers })
  } catch (error) {
    const status =
      error instanceof TracerError
        ? error.code === "UNAUTHORIZED"
          ? 401
          : error.code === "NOT_FOUND"
            ? 404
            : 400
        : 503
    return NextResponse.json(
      {
        error:
          status === 503
            ? "Webhook admission is temporarily unavailable."
            : "Webhook rejected.",
      },
      { status, headers }
    )
  }
}
