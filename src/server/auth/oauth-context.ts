import { AsyncLocalStorage } from "node:async_hooks"
// The project shown in the approval form belongs to this request, never mutable session state.
const key = Symbol.for("datool.oauth.project")
const registry = globalThis as typeof globalThis & {
  [key]?: AsyncLocalStorage<string>
}
const context = (registry[key] ??= new AsyncLocalStorage<string>())
export const selectedOAuthProject = () => context.getStore()
export const withOAuthProject = <T>(projectId: string, action: () => T) =>
  context.run(projectId, action)
