import type {
  AppDefinition,
  Attempt,
  Playground,
  PlaygroundNode,
} from "./contracts"

export function atPath(value: unknown, path: string): unknown {
  if (!path) return value
  return path.split(".").reduce<unknown>((current, key) => {
    if (["__proto__", "prototype", "constructor"].includes(key))
      throw new Error("Invalid field path")
    return current && typeof current === "object" && Object.hasOwn(current, key)
      ? (current as Record<string, unknown>)[key]
      : undefined
  }, value)
}
export function validateGraph(nodes: PlaygroundNode[]) {
  const ids = new Set(nodes.map((n) => n.id))
  if (ids.size !== nodes.length) throw new Error("Node IDs must be unique")
  for (const n of nodes) {
    if (
      Object.keys(n.bindings).some((k) =>
        ["__proto__", "prototype", "constructor"].includes(k)
      )
    )
      throw new Error("Invalid input field")
    const visit = (id: string, seen: Set<string>) => {
      if (!ids.has(id)) throw new Error(`Missing dependency: ${id}`)
      if (seen.has(id)) throw new Error("Connections cannot create a cycle")
      const node = nodes.find((n) => n.id === id)!
      const next = new Set([...seen, id])
      for (const dep of dependencies(node)) visit(dep, next)
    }
    visit(n.id, new Set())
  }
}
export function dependencies(node: PlaygroundNode) {
  return [
    ...new Set([
      ...node.dependsOn,
      ...Object.values(node.bindings).flatMap((b) =>
        b.source === "output" ? [b.nodeId] : []
      ),
    ]),
  ]
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (k) =>
          `${JSON.stringify(k)}:${stable((value as Record<string, unknown>)[k])}`
      )
      .join(",")}}`
  return JSON.stringify(value) ?? "null"
}
export function resolveNode(
  playground: Playground,
  nodeId: string,
  attempts: Attempt[],
  apps: AppDefinition[],
  visiting = new Set<string>()
): {
  input: Record<string, unknown>
  upstream: Record<string, string>
  signature: string
} {
  if (visiting.has(nodeId)) throw new Error("Connections cannot create a cycle")
  const node = playground.nodes.find((n) => n.id === nodeId)
  if (!node) throw new Error("Node not found")
  const app = apps.find((a) => a.id === node.appId)
  if (!app) throw new Error(`App ${node.appId} is not registered`)
  const upstream: Record<string, string> = {}
  const outputs: Record<string, unknown> = {}
  for (const depId of dependencies(node)) {
    const dep = playground.nodes.find((n) => n.id === depId)
    const attempt = attempts.find(
      (a) =>
        a.id === dep?.selectedAttemptId &&
        a.nodeId === depId &&
        a.playgroundId === playground.id
    )
    if (!attempt || attempt.status !== "completed")
      throw new Error(`Select a completed output for ${dep?.label ?? depId}`)
    const resolved = resolveNode(
      playground,
      depId,
      attempts,
      apps,
      new Set([...visiting, nodeId])
    )
    if (resolved.signature !== attempt.signature)
      throw new Error(
        `${dep?.label ?? depId} has outdated inputs; run it again and select an output`
      )
    upstream[depId] = attempt.id
    outputs[depId] = attempt.output
  }
  const input = { ...node.input }
  for (const [key, binding] of Object.entries(node.bindings)) {
    const value = atPath(
      binding.source === "shared" ? playground.shared : outputs[binding.nodeId],
      binding.path
    )
    if (value === undefined) throw new Error(`Missing bound value for ${key}`)
    input[key] = value
  }
  return {
    input,
    upstream,
    signature: stable({ input, upstream, appRevision: app.revision }),
  }
}
