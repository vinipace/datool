import { expect, test } from "bun:test"
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { DiagnosticQueue } from "../src/lib/diagnostics-core"
import { diagnosticError, type DiagnosticReport } from "../../../src/lib/inbox/diagnostics"

const report = (index = 0): DiagnosticReport => ({
  id: crypto.randomUUID(), occurredAt: new Date(Date.now() - index * 60_001).toISOString(),
  stage: "google_sign_in", code: "OAUTH_FAILED", platform: "ios",
  appVersion: "1.0.0", buildVersion: "11", online: false,
})

test("offline diagnostic retry survives restart, preserves IDs and concurrent new reports", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-diagnostics-"))
  const disk = {
    getItem: (key: string) => readFile(join(dir, key), "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error }),
    setItem: (key: string, value: string) => writeFile(join(dir, key), value),
  }
  try {
    const original = report()
    await new DiagnosticQueue(disk, "queue").add(original)
    await new DiagnosticQueue(disk, "queue").flush(async () => "retry")
    const queue = new DiagnosticQueue(disk, "queue")
    const sent: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    let started!: () => void
    const sending = new Promise<void>(resolve => { started = resolve })
    const flush = queue.flush(async item => { sent.push(item.id); started(); await gate; return "saved" })
    await sending
    const other = { ...report(), stage: "api" as const }
    await queue.add(other)
    const concurrent = queue.flush(async () => { throw Error("Must not drain twice") })
    release()
    await Promise.all([flush, concurrent])
    expect(sent).toEqual([original.id, other.id])
    expect(JSON.parse((await disk.getItem("queue"))!)).toEqual([])
    // A repeated polling failure is bounded; permanent validation errors do not
    // block the next report, and the queue never grows without limit.
    for (let index = 39; index >= 0; index--) await queue.add(report(index))
    await queue.add(report())
    expect(JSON.parse((await disk.getItem("queue"))!)).toHaveLength(30)
    await queue.flush(async () => "discard")
    expect(JSON.parse((await disk.getItem("queue"))!)).toEqual([])
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test("diagnostics retain only recognized codes and statuses from credential-bearing errors", () => {
  const error = Object.assign(new Error("alice@example.test cookie=SECRET https://provider/?code=SECRET"), {
    code: "OAUTH_FAILED", status: 401, stack: "Bearer SECRET", cause: { token: "SECRET" },
  })
  expect(diagnosticError(error)).toEqual({ code: "OAUTH_FAILED", httpStatus: 401 })
  expect(diagnosticError({ code: "SECRET", status: 700, message: "SECRET" })).toEqual({ code: "UNKNOWN" })
  expect(diagnosticError(new DOMException("SECRET", "TimeoutError"))).toEqual({ code: "TIMEOUT" })
  expect(diagnosticError(new TypeError("Network request failed"))).toEqual({ code: "NETWORK_ERROR" })
})
