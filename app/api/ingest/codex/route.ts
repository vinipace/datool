import { readJson } from "@/lib/api-response"
import { withWorkspace } from "@/src/server/auth/context"
import {
  parseCodexSnapshot,
  persistCodexSnapshot,
} from "@/src/server/codex-traces/persist"
import { createTracerDatabase } from "@/src/server/tracer/db"
import { TracerError, validation } from "@/src/server/tracer/errors"
import {
  apiError,
  assertTracerMutationOrigin,
  authorizeProject,
} from "@/src/server/tracer/http"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export async function POST(request: Request) {
  try {
    const context = await authorizeProject(request)
    assertTracerMutationOrigin(request)
    const body = await readJson(request, 16 * 1024 * 1024)
    if (body.kind === "too-large")
      throw new TracerError(
        "VALIDATION_ERROR",
        "Codex snapshot exceeds 16 MiB; raw capture remains in the connector journal",
        { status: 413 }
      )
    if (body.kind === "invalid")
      throw validation("Expected a JSON Codex snapshot")
    const snapshot = parseCodexSnapshot(body.value)
    const data = await withWorkspace(context.identity, () =>
      persistCodexSnapshot(
        createTracerDatabase(undefined, { projectId: context.projectId }),
        snapshot
      )
    )
    return Response.json({ data }, { headers: { "Cache-Control": "no-store" } })
  } catch (error) {
    return apiError(error)
  }
}
