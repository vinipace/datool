type Entry = { body: string; etag: string; bytes: number; savedAt: number }

/** Bounded, project-scoped validators. Every reuse still goes through authorization. */
export function createConditionalReadCache(now = Date.now) {
  const entries = new Map<string, Entry>()
  let bytes = 0
  const remove = (key: string) => {
    bytes -= entries.get(key)?.bytes ?? 0
    entries.delete(key)
  }
  return {
    clear() { entries.clear(); bytes = 0 },
    async fetch(key: string, load: (etag?: string) => Promise<Response>, force = false) {
      const cached = entries.get(key)
      const usable = !force && cached && now() - cached.savedAt < 60_000 ? cached : undefined
      const response = await load(usable?.etag)
      if (response.status === 304 && usable) {
        return new Response(usable.body, { status: 200, headers: { "content-type": "application/json" } })
      }
      if (!response.ok) { remove(key); return response }
      const etag = response.headers.get("etag")
      if (!etag) { remove(key); return response }
      const body = await response.clone().text()
      const size = new TextEncoder().encode(body).byteLength
      remove(key)
      if (size <= 2 * 1024 * 1024) {
        entries.set(key, { body, etag, bytes: size, savedAt: now() })
        bytes += size
        while (entries.size > 32 || bytes > 8 * 1024 * 1024) remove(entries.keys().next().value!)
      }
      return response
    },
  }
}
