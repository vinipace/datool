import { AsyncLocalStorage } from "node:async_hooks"
import type { PromptOverrides, PromptRunScope } from "./prompt-overrides"

type Scope = {
  active: boolean
  clients: Map<object, PromptOverrides>
  run?: PromptRunScope
}
// Shared by the built CLI and separately bundled SDK, but never holds global overrides.
const key = Symbol.for("datool.prompt-scope.v1")
const registry = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<Scope>
}
const storage = (registry[key] ??= new AsyncLocalStorage<Scope>())
export function getPromptScope() {
  const scope = storage.getStore()
  return scope?.active ? scope : undefined
}
export function withPromptScope<T>(
  action: () => T,
  options?: { fresh?: boolean; run?: PromptRunScope }
): T {
  const parent = options?.fresh ? undefined : getPromptScope()
  const scope: Scope = {
    active: true,
    clients: new Map(
      [...(parent?.clients ?? [])].map(([client, overrides]) => [
        client,
        structuredClone(overrides),
      ])
    ),
    run: options?.run ?? parent?.run,
  }
  const cleanup = () => {
    scope.active = false
    scope.clients.clear()
  }
  return storage.run(scope, () => {
    try {
      const result = action()
      if (
        result &&
        typeof (result as unknown as PromiseLike<unknown>).then === "function"
      )
        return Promise.resolve(result).finally(cleanup) as T
      cleanup()
      return result
    } catch (error) {
      cleanup()
      throw error
    }
  })
}
