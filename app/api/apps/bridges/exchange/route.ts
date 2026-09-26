import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { BridgeConflict, bridgeExchangeSchema, relay } from "@/src/server/apps/relay"
export const runtime = "nodejs"
export const POST = workspaceRoute(async (request) => {
  const parsed = bridgeExchangeSchema.safeParse(await readJson(request))
  if (!parsed.success)
    return Response.json(
      { error: { message: "Invalid bridge exchange." } },
      { status: 400 }
    )
  try {
    return Response.json({ data: await relay.exchange(parsed.data) })
  } catch (error) {
    if (!(error instanceof BridgeConflict)) throw error
    return Response.json(
      {
        error: {
          message:
            error instanceof Error ? error.message : "Bridge exchange failed.",
        },
      },
      { status: 409 }
    )
  }
})
