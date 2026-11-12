import { defineDynamic, defineTool } from "eve/tools"
import type { ToolDefinition } from "eve/tools"
import bash from "eve/tools/bash"
import readFile from "eve/tools/read_file"
import writeFile from "eve/tools/write_file"
import editFile from "eve/tools/edit_file"
import glob from "eve/tools/glob"
import grep from "eve/tools/grep"
import webFetch from "eve/tools/web_fetch"
import {
  executionContext,
  builtinEnabled,
  executeEveBuiltin,
} from "@datool/eve-bridge"

const native = {
  bash,
  read_file: readFile,
  write_file: writeFile,
  edit_file: editFile,
  glob,
  grep,
  web_fetch: webFetch,
}
export default defineDynamic(async (ctx) => {
  const { context, run } = await executionContext(ctx)
  return Object.fromEntries(
    Object.entries(native)
      .filter(([name]) => builtinEnabled(run, name))
      .map(([name, definition]) => {
        const tool = definition as ToolDefinition
        return [
          name,
          defineTool({
            ...tool,
            deferred: true,
            async execute(input, toolContext) {
              let mutationStarted = false
              const guardedContext = new Proxy(toolContext, {
                get(target, key) {
                  if (key !== "getSandbox") return Reflect.get(target, key)
                  return async (
                    ...args: Parameters<typeof target.getSandbox>
                  ) => {
                    const sandbox = await target.getSandbox(...args)
                    return new Proxy(sandbox, {
                      get(value, member) {
                        const method = Reflect.get(value, member)
                        if (typeof method !== "function") return method
                        return (...inputs: unknown[]) => {
                          if (
                            String(member).startsWith("write") ||
                            member === "removePath" ||
                            (name === "bash" &&
                              (member === "spawn" || member === "run"))
                          )
                            mutationStarted = true
                          return Reflect.apply(method, value, inputs)
                        }
                      },
                    })
                  }
                },
              })
              return executeEveBuiltin(
                context,
                run.turnId,
                name,
                input,
                toolContext.callId,
                async () => tool.execute(input, guardedContext),
                () => mutationStarted
              )
            },
          }),
        ]
      })
  )
})
