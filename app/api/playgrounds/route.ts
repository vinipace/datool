import { workspaceRoute } from "@/src/server/tracer/http"
import { NextResponse } from "next/server"
import { assertLocalMutation } from "@/src/server/tracer/http"
import { readState } from "@/src/server/playground/storage"
import { createPlayground } from "@/src/server/playground/service"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
async function GETHandler() {
  return NextResponse.json({ data: (await readState()).playgrounds })
}
async function POSTHandler(request: Request) {
  try {
    assertLocalMutation(request)
    return NextResponse.json({
      data: await createPlayground(await request.json()),
    })
  } catch (error) {
    return NextResponse.json(
      { error: { message: (error as Error).message } },
      { status: 400 }
    )
  }
}

export const GET = workspaceRoute(GETHandler)
export const POST = workspaceRoute(POSTHandler)
