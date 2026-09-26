import { resolve } from "node:path"

/** Global host/project/env flags have already been consumed by loadConfiguration. */
export function connectOptions(
  args: string[],
  root: string,
  cwd = process.cwd()
) {
  let target: string | undefined
  let name: string | undefined
  let mode: "input" | "agent" = "input"
  let watch = false
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === "--watch" || arg === "--no-watch") {
      watch = arg === "--watch"
    } else if (arg === "--mode" || arg === "--name") {
      const value = args[++index]
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value.`)
      if (arg === "--name") name = value
      else {
        if (!["workflow", "input", "agent"].includes(value))
          throw new Error(
            "--mode must be workflow or agent (input is a legacy alias for workflow)."
          )
        mode = value === "agent" ? "agent" : "input"
      }
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown connect option: ${arg}`)
    } else if (target) {
      throw new Error(
        "connect accepts one manifest, handler file, or HTTP URL."
      )
    } else target = arg
  }
  if (watch && target && /^https?:\/\//.test(target))
    throw new Error(
      "--watch is for local manifests and handlers, not HTTP webhooks."
    )
  return {
    watch,
    target: target
      ? /^https?:\/\//.test(target)
        ? target
        : resolve(cwd, target)
      : resolve(root, "datool.config.ts"),
    defaultManifest: target === undefined,
    name,
    mode,
  }
}
