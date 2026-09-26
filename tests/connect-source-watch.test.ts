import { expect, test } from "bun:test"
import { mkdtemp, mkdir, writeFile, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { watchSourceFiles } from "../bin/connect-source-watch"

test("JSON config and atomic source saves reload; generated JSON trees do not", async () => {
  const root = await mkdtemp(join(tmpdir(), "datool-source-watch-"))
  let changes = 0
  let error: Error | undefined
  const close = await watchSourceFiles(
    [root],
    () => {
      changes++
    },
    (value) => {
      error = value
    }
  )
  async function changedSince(before: number) {
    for (let i = 0; i < 100 && changes === before; i++) await delay(25)
    expect(error).toBeUndefined()
    expect(changes > before).toBe(true)
    await delay(1100) // includes the periodic fallback; no duplicate notification
    expect(changes).toBe(before + 1)
  }
  try {
    await mkdir(join(root, "config"))
    await writeFile(join(root, "config/settings.json"), '{"model":"one"}')
    await changedSince(0)
    await writeFile(join(root, "config/settings.json"), '{"model":"two"}')
    await changedSince(1)
    await writeFile(join(root, "next.tmp"), "export default 42")
    await rename(join(root, "next.tmp"), join(root, "handler.ts"))
    await changedSince(2)
    for (const directory of [
      "tmp/evals",
      "temp",
      "artifacts",
      "test-results",
      "playwright-report",
      "node_modules",
      "dist",
    ]) {
      await mkdir(join(root, directory), { recursive: true })
      await writeFile(join(root, directory, "result.json"), "{}")
    }
    await delay(1400)
    expect(changes).toBe(3)
  } finally {
    close()
    await rm(root, { recursive: true, force: true })
  }
}, 15000)
