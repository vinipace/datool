import { createHash } from "node:crypto"
import { createEveFixture, eveResponse, toolOutputs } from "./eve-fixture"
import { runAgentTurn, type RunAgentTurnOptions } from "@/src/server/build/runtime"
import type { BuildContext } from "@/src/server/build/context"
import type { IsolatedPostgres } from "./postgres"

const nativeFetch = globalThis.fetch
type ScriptInput = { tools: Record<string, { execute(input: unknown, options?: unknown): Promise<unknown> }>; system: string; messages: Array<{ role: string; content: string }> }
type Script = (input: ScriptInput) => Promise<{ text: string }>
type Options = Omit<RunAgentTurnOptions, "dependencies"> & { dependencies?: RunAgentTurnOptions["dependencies"] & { script?: unknown } }

/** Drive the real vendor protocol from an imperative synthetic agent script.
 * Each execute pauses until Eve actually invokes the published capability and
 * sends its result in the next model request. It never executes a Datool tool.
 */
function scriptProvider(fixture: Awaited<ReturnType<typeof createEveFixture>>, script: Script) {
  let failure: unknown
  let resolveResult: ((value: unknown) => void) | undefined
  let emit: (response: Response) => void
  fixture.provider(body => {
    const response = new Promise<Response>(resolve => { emit = resolve })
    const outputs = toolOutputs(body)
    if (resolveResult) {
      const resolve = resolveResult
      resolveResult = undefined
      resolve(outputs.at(-1))
    } else {
      const messages = (body.input as Array<{ role?: string; content?: unknown }>).filter(item => item.role).map(item => ({ role: item.role!, content: typeof item.content === "string" ? item.content : Array.isArray(item.content) ? item.content.map(part => part.text ?? "").join("\n") : "" }))
      const tools = new Proxy({}, { get: (_, property) => ({ execute: (input: unknown) => new Promise((resolve, reject) => {
        resolveResult = value => {
          if (value && typeof value === "object" && "error" in value) {
            const failure = value.error
            reject(typeof failure === "string" ? new Error(failure) : Object.assign(new Error(String((failure as { message?: unknown }).message)), { code: (failure as { kind?: string }).kind }))
          } else resolve(value)
        }
        const id = String(property)
        const kind = id.startsWith("procedure_") ? "procedure" : "action"
        const raw = kind === "procedure" ? id.slice("procedure_".length) : id
        const name = id === "sandbox_command" ? id : `${kind}_${createHash("sha256").update(raw).digest("hex").slice(0,32)}`
        emit(eveResponse(body, "", { name: "eve__tool", input: { name, input } }))
      }) }) }) as ScriptInput["tools"]
      void script({ tools, system: messages.filter(item => item.role === "system").map(item => item.content).join("\n"), messages }).then(result => emit(eveResponse(body, result.text))).catch(error => { failure = error; emit(Response.json({ error: { message: "Synthetic agent script failed." } }, { status: 403 })) })
    }
    return response
  })
  return () => failure
}

export function scriptedEveRunner(targetFor: (context: BuildContext) => IsolatedPostgres, cleanup: Array<() => Promise<void>>) {
  const instances = new WeakMap<BuildContext["database"], Awaited<ReturnType<typeof createEveFixture>>>()
  return async (context: BuildContext, input: Parameters<typeof runAgentTurn>[1], options: Options = {}) => {
    const upstream = globalThis.fetch
    globalThis.fetch = ((url, init) => new URL(url instanceof Request ? url.url : String(url)).hostname === "127.0.0.1" ? nativeFetch(url, init) : upstream(url, init)) as typeof fetch
    let fixture = instances.get(context.database)
    if (!fixture) {
      fixture = await createEveFixture({ target: targetFor(context), upstream: ((url, init) => globalThis.fetch(url, init)) as typeof fetch })
      instances.set(context.database, fixture)
      cleanup.unshift(() => fixture!.close())
    }
    const { script, ...dependencies } = options.dependencies ?? {}
    const scriptFailure = typeof script === "function" ? scriptProvider(fixture, script as Script) : () => undefined
    try {
      const result = await runAgentTurn(context, input, { ...options, dependencies })
      if (scriptFailure()) throw scriptFailure()
      return result
    } catch (error) { throw scriptFailure() ?? error }
  }
}
