import { workspaceRoute } from "@/src/server/tracer/http"
import { NextResponse } from "next/server"
import { z } from "zod"
import { assertLocalMutation } from "@/src/server/tracer/http"
import {
  getDetail,
  savePlayground,
  runNode,
  selectAttempt,
  evaluateAttempt,
} from "@/src/server/playground/service"
export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 120
const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    playground: z.unknown(),
    revision: z.number(),
  }),
  z.object({
    action: z.literal("run"),
    nodeId: z.string(),
    revision: z.number(),
  }),
  z.object({
    action: z.literal("select"),
    attemptId: z.string(),
    revision: z.number(),
  }),
  z.object({
    action: z.literal("evaluate"),
    attemptId: z.string(),
    evaluatorIds: z.array(z.string()),
  }),
])
type Context = { params: Promise<{ id: string }> }
async function GETHandler(_request: Request, context: Context) {
  try {
    return NextResponse.json({
      data: await getDetail((await context.params).id),
    })
  } catch (error) {
    return NextResponse.json(
      { error: { message: (error as Error).message } },
      { status: 404 }
    )
  }
}
async function POSTHandler(request: Request, context: Context) {
  try {
    assertLocalMutation(request)
    const { id } = await context.params
    const body = actionSchema.parse(await request.json())
    const data =
      body.action === "save"
        ? await savePlayground(id, body.playground, body.revision)
        : body.action === "run"
          ? await runNode(id, body.nodeId, body.revision)
          : body.action === "select"
            ? await selectAttempt(id, body.attemptId, body.revision)
            : await evaluateAttempt(id, body.attemptId, body.evaluatorIds)
    return NextResponse.json({ data })
  } catch (error) {
    return NextResponse.json(
      { error: { message: (error as Error).message } },
      { status: 400 }
    )
  }
}

export const GET = workspaceRoute(GETHandler)
export const POST = workspaceRoute(POSTHandler)
