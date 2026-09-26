import { readFile, readdir } from "node:fs/promises"
import { join } from "node:path"

async function pages(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory()
          ? pages(path)
          : path.endsWith(".mdx")
            ? [path]
            : []
      })
    )
  ).flat()
}
const links = new Map<string, Set<string>>()
for (const path of await pages("content/docs")) {
  const body = (await readFile(path, "utf8")).replace(
    /^```[^\n]*\n[\s\S]*?^```\s*$/gm,
    ""
  )
  for (const match of body.matchAll(/\[[^\]]+\]\((https?:\/\/[^\s)]+)\)/g)) {
    const url = new URL(match[1])
    url.hash = ""
    const key = url.href
    if (!links.has(key)) links.set(key, new Set())
    links.get(key)!.add(path)
  }
}
let failed = 0
const pending = [...links]
await Promise.all(
  Array.from({ length: 4 }, async () => {
    for (;;) {
      const entry = pending.shift()
      if (!entry) return
      const [url, sources] = entry
      try {
        // Anonymous GET catches private repositories; HEAD can have different routing.
        const response = await fetch(url, {
          redirect: "follow",
          signal: AbortSignal.timeout(20_000),
        })
        await response.body?.cancel()
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        console.log(`OK ${response.status} ${url}`)
      } catch (error) {
        failed++
        console.error(
          `CHECK ${url}: ${error instanceof Error ? error.message : String(error)} (${[...sources].join(", ")})`
        )
      }
    }
  })
)
console.log(
  `${links.size - failed}/${links.size} external documentation links reachable anonymously.`
)
if (failed) process.exitCode = 1
