import type { JsonObject } from "@/src/lib/tracer/contracts"
import { TracerError } from "@/src/server/tracer/errors"

/** Only platform-authored messages and allowlisted context cross into traces
 * and model feedback. Remote exception messages can contain credentials.
 */
export class McpRuntimeError extends TracerError {
  readonly uncertain: boolean
  constructor(
    readonly runtimeCode: string,
    message: string,
    details: JsonObject,
    cause?: unknown
  ) {
    super("VALIDATION_ERROR", message, {
      details: { integration: "custom_mcp", ...details },
      cause,
    })
    this.name = "McpRuntimeError"
    this.uncertain = runtimeCode === "ACTION_UNCERTAIN"
  }
}
