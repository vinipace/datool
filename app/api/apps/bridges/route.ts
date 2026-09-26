import { workspaceRoute, readJson } from "@/src/server/tracer/http"
import { BridgeConflict, bridgeSessionSchema, relay } from "@/src/server/apps/relay"
export const runtime = "nodejs"
export const POST = workspaceRoute(async (request) => {
  const parsed = bridgeSessionSchema.safeParse(await readJson(request))
  if (!parsed.success)
    return Response.json(
      {
        error: {
          message:
            "This server requires an outbound bridge. Update @datool/cli.",
        },
      },
      { status: 400 }
    )
  try {
    return Response.json({ data: await relay.register(parsed.data) })
  } catch (error) {
    if (!(error instanceof BridgeConflict)) throw error
    return Response.json(
      {
        error: {
          message:
            error instanceof Error
              ? error.message
              : "Unable to register bridge.",
        },
      },
      { status: 409 }
    )
  }
})
