import { workspaceRoute } from "@/src/server/tracer/http"
import { NextResponse } from "next/server"
import { assertLocalMutation, readJson } from "@/src/server/tracer/http"
import {
  publicConnection,
  readConnections,
  saveConnection,
} from "@/src/server/apps/store"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
async function GETHandler() {
  return NextResponse.json({
    data: (await readConnections()).map(publicConnection),
  })
}
async function POSTHandler(request: Request) {
  try {
    assertLocalMutation(request)
    return NextResponse.json({
      data: publicConnection(await saveConnection(await readJson(request))),
    })
  } catch (error) {
    return NextResponse.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Could not save app",
        },
      },
      { status: 400 }
    )
  }
}

export const GET = workspaceRoute(GETHandler)
export const POST = workspaceRoute(POSTHandler)
