import { defineSandbox } from "eve/sandbox"
import {
  defineSandboxProvider,
  SandboxSessionGoneError,
} from "eve/sandbox/provider"
import {
  executionContext,
  openDatoolSandbox,
  closeDatoolSandbox,
  DatoolSandboxGoneError,
} from "@datool/eve-bridge"
import type { DatoolSandboxState } from "@datool/eve-bridge"

const DatoolSandbox = defineSandboxProvider({
  name: "datool",
  environment() {
    return {
      async prepare(ctx) {
        if (!ctx.isEmpty)
          throw new Error(
            "Datool environments use database-defined drives, not build-time workspace files."
          )
        return { version: 1 }
      },
      async start(ctx) {
        const { context, run } = await executionContext(ctx)
        return openDatoolSandbox(context, run, ctx.session.id).catch(
          translateGone
        )
      },
      async resume(ctx, _artifact, state: DatoolSandboxState) {
        const { context, run } = await executionContext(ctx)
        return (
          await openDatoolSandbox(context, run, ctx.session.id, state).catch(
            translateGone
          )
        ).connection
      },
      async onSessionEnd(ctx) {
        const { context, run } = await executionContext(ctx, false)
        await closeDatoolSandbox(context, run.turnId)
      },
    }
  },
})

function translateGone(error: unknown): never {
  if (error instanceof DatoolSandboxGoneError)
    throw new SandboxSessionGoneError(error.message)
  throw error
}

export const environment = DatoolSandbox.environment()
export default defineSandbox(() => environment.open())
