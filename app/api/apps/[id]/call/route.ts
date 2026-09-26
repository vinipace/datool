import { workspaceRoute } from "@/src/server/tracer/http"
import { randomUUID } from "node:crypto"
import { NextResponse } from "next/server"
import { assertLocalMutation, readJson } from "@/src/server/tracer/http"
import { invokeConnection, readConnections } from "@/src/server/apps/store"
export const runtime = "nodejs"
async function POSTHandler(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const callId = randomUUID()
  const headers = { "x-datool-call-id": callId }
  try {
    assertLocalMutation(request)
    const { id } = await context.params
    const app = (await readConnections()).find((app) => app.id === id)
    if (!app)
      return NextResponse.json(
        { error: { message: "App not found" } },
        { status: 404 }
      )
    return NextResponse.json(
      {
        data: await invokeConnection(app, await readJson(request), callId),
      },
      { headers }
    )
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message: error instanceof Error ? error.message : "App call failed",
        },
      },
      { status: 400, headers }
    )
  }
}

export const POST = workspaceRoute(POSTHandler)
