import type { CompiledTraceView } from "./trace-view-contract"
const cacheKey = "datool:compiled-trace-views:v1"
const pending = new Map<string, Promise<CompiledTraceView>>()
const memory = new Map<string, CompiledTraceView>()
let manifest: Promise<{ buildId: string }> | undefined
const maxCachedViews = 8

/** Compiles only on code/build changes, in a short-lived worker outside the UI. */
export async function prepareTraceView(source: string): Promise<CompiledTraceView> {
  manifest ??= fetch("/trace-views/manifest.json", { cache: "no-cache" }).then(async response => {
    if (!response.ok) throw new Error("Could not load the view runtime. Reload and try again.")
    return response.json()
  }).catch(error => { manifest = undefined; throw error })
  const { buildId } = await manifest
  const key = `${buildId}:${source}`
  if (memory.has(key)) return memory.get(key)!
  if (pending.has(key)) return pending.get(key)!
  let cached: CompiledTraceView[] = []
  try {
    cached = JSON.parse(localStorage.getItem(cacheKey) ?? "[]")
    const hit = cached.find(item => item.source === source && item.buildId === buildId && typeof item.javascript === "string" && typeof item.css === "string" && Array.isArray(item.modules))
    if (hit) return hit
  } catch { cached = [] }
  const promise = new Promise<CompiledTraceView>((resolve, reject) => {
    const worker = new Worker(`/trace-views/compiler.js?v=${buildId}`)
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error("View compilation timed out. Simplify the view and try again.")) }, 15_000)
    const finish = () => { clearTimeout(timeout); worker.terminate() }
    worker.onerror = () => { finish(); reject(new Error("Could not compile the view. Check its code and retry.")) }
    worker.onmessage = (event: MessageEvent<{ artifact?: CompiledTraceView; error?: string }>) => {
      finish()
      if (!event.data.artifact) { reject(new Error(event.data.error ?? "Compilation failed.")); return }
      const artifact = event.data.artifact
      if (artifact.buildId !== buildId || artifact.source !== source) { manifest = undefined; reject(new Error("The view runtime changed. Reload and try again.")); return }
      memory.set(key, artifact)
      if (memory.size > maxCachedViews) memory.delete(memory.keys().next().value!)
      try { localStorage.setItem(cacheKey, JSON.stringify([...cached.filter(item => item.source !== source && item.buildId === buildId), artifact].slice(-maxCachedViews))) } catch { /* A full storage quota must not prevent an in-memory preview. */ }
      resolve(artifact)
    }
    worker.postMessage({ source })
  })
  pending.set(key, promise)
  try { return await promise } finally { pending.delete(key) }
}
