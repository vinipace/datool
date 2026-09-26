import { watch, type FSWatcher } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { extname, join } from "node:path"

const ignored = new Set([
  "node_modules",
  ".git",
  ".next",
  ".datool",
  "dist",
  "build",
  "coverage",
  "storybook-static",
  ".turbo",
  ".cache",
  "tmp",
  "temp",
  "artifacts",
  "test-results",
  "playwright-report",
])
const extensions = new Set([
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yaml",
  ".yml",
])

/** Filter before traversing, so generated output never adds watchers or reloads.
 * Native events are hints: a periodic snapshot also catches missed Bun/OS events.
 */
export async function watchSourceFiles(
  roots: string[],
  changed: () => void,
  failed: (error: Error) => void
) {
  const watchers = new Map<string, FSWatcher>()
  let previous: Map<string, string> | undefined
  let stopped = false
  let scanning = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const ignore = (name: string) =>
    ignored.has(name) || name.startsWith(".next-")
  function schedule() {
    if (stopped || timer) return
    timer = setTimeout(() => {
      timer = undefined
      void scan()
    }, 50)
  }
  async function scan() {
    if (stopped || scanning) return
    scanning = true
    try {
      const files = new Map<string, string>()
      const directories = new Set<string>()
      async function visit(directory: string): Promise<void> {
        try {
          const entries = await readdir(directory, { withFileTypes: true })
          directories.add(directory)
          if (!watchers.has(directory)) {
            const watcher = watch(directory, (_event, file) => {
              if (!file || !ignore(file)) schedule()
            })
            watcher.on("error", schedule)
            watchers.set(directory, watcher)
          }
          await Promise.all(
            entries
              .filter((entry) => !ignore(entry.name))
              .map(async (entry) => {
                const path = join(directory, entry.name)
                if (entry.isDirectory()) return visit(path)
                if (!entry.isFile() || !extensions.has(extname(entry.name)))
                  return
                try {
                  const info = await stat(path)
                  files.set(path, `${info.mtimeMs}:${info.size}:${info.ino}`)
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                    throw error
                }
              })
          )
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
        }
      }
      await Promise.all(roots.map(visit))
      for (const [directory, watcher] of watchers) {
        if (!directories.has(directory) || stopped) {
          watcher.close()
          watchers.delete(directory)
        }
      }
      if (
        !stopped &&
        previous &&
        (previous.size !== files.size ||
          [...files].some(([path, stamp]) => previous!.get(path) !== stamp))
      )
        changed()
      previous = files
    } catch (error) {
      if (!stopped) failed(error as Error)
    } finally {
      scanning = false
    }
  }
  await scan()
  const fallback = setInterval(() => {
    void scan()
  }, 1000)
  return () => {
    stopped = true
    clearInterval(fallback)
    clearTimeout(timer)
    for (const watcher of watchers.values()) watcher.close()
    watchers.clear()
  }
}
