#!/usr/bin/env bun
/** Real Codex -> local OTLP receiver -> App Server enrichment -> HTTP -> PostgreSQL proof. */
import { spawn } from "node:child_process"
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve, join } from "node:path"
import assert from "node:assert/strict"
import { DatoolClient } from "../src/lib/tracer/client"
import type { TraceDetail, JsonObject } from "../src/lib/tracer/contracts"

const baseUrl = process.env.DATOOL_BASE_URL ?? "http://localhost:3000"
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(baseUrl).hostname))
  throw new Error("This E2E test must target local Datool")
const client = new DatoolClient({ baseUrl })
await client.request("/api/traces?limit=1")
const workspace = await mkdtemp(join(tmpdir(), "datool-codex-e2e-"))
const stateDir = resolve(
  process.env.DATOOL_CODEX_E2E_STATE_DIR ?? `.data/codex-e2e/${Date.now()}`
)
await mkdir(stateDir, { recursive: true, mode: 0o700 })
await writeFile(
  join(workspace, "input.json"),
  JSON.stringify({ numbers: [3, 7, 11] })
)
const prompt = `Datool local tracing E2E canary. Work only in ${workspace}.
Use the terminal to execute this intentionally failing command exactly once: printf 'DATOOL_EXPECTED_FAILURE\\n' >&2; exit 7
Then use a separate terminal command to read input.json with Python, sum its numbers, write result.json as {"sum": 21}, and print DATOOL_SUM=21. Actually execute both commands; the first failure is expected and you should recover from it.
Finish with exactly DATOOL_SUM=21. Do not access the network, invoke external tools, read credentials, or change anything outside this directory.`

function run(args: string[], command = "run") {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>(
    (resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "scripts/codex-traces.ts",
          command,
          "--state-dir",
          stateDir,
          ...(command === "run" ? ["--"] : []),
          ...args,
        ],
        {
          cwd: process.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        }
      )
      let stdout = "",
        stderr = ""
      child.stdout.on("data", (data) => {
        stdout += data
      })
      child.stderr.on("data", (data) => {
        stderr += data
      })
      child.on("error", reject)
      child.on("close", (code) => resolve({ stdout, stderr, code }))
    }
  )
}
const first = await run([
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--sandbox",
  "workspace-write",
  "-C",
  workspace,
  "--json",
  prompt,
])
await writeFile(join(stateDir, "codex-events.jsonl"), first.stdout, {
  mode: 0o600,
})
await writeFile(join(stateDir, "connector.log"), first.stderr, { mode: 0o600 })
assert.equal(
  first.code,
  0,
  `Codex connector failed; inspect ${stateDir}/connector.log`
)
assert.deepEqual(
  JSON.parse(await readFile(join(workspace, "result.json"), "utf8")),
  { sum: 21 }
)
const events = first.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
const threadId = events.find((e) => e.type === "thread.started")?.thread_id
assert(threadId, "Codex did not report its thread ID")
const usage = events.find((e) => e.type === "turn.completed")?.usage
assert(usage, "Codex did not report completed turn usage")
const receipts = first.stderr.split("\n").flatMap((line) => {
  try {
    const value = JSON.parse(line)
    return value.event === "datool.trace.saved" ? [value] : []
  } catch {
    return []
  }
})
const receipt = receipts.find((r) => r.threadId === threadId)
assert(receipt, "Datool did not report a committed trace")
const trace = await client.request<TraceDetail>(
  `/api/traces/${receipt.traceId}`
)
assert.equal(trace.status, "completed")
assert.equal(trace.output, "DATOOL_SUM=21")
assert.equal(trace.attributes["usage.input_tokens"], usage.input_tokens)
assert.equal(trace.attributes["usage.output_tokens"], usage.output_tokens)
assert.equal(
  trace.attributes["usage.cache_read_tokens"],
  usage.cached_input_tokens
)
assert.equal(trace.attributes["codex.usage.reconciliation"], "matched")
const tools = trace.spans.filter((s) => s.kind === "tool")
assert(
  tools.some(
    (s) => s.status === "errored" && (s.output as JsonObject)?.exitCode === 7
  ),
  "Expected failing tool was not recorded"
)
assert(
  tools.some((s) => JSON.stringify(s.output).includes("DATOOL_SUM=21")),
  "Successful tool output is missing"
)
assert(
  trace.spans
    .filter((s) => s.kind === "llm")
    .every((s) => s.input !== null && s.output !== null),
  "Model request context or response items are missing"
)
const result = {
  verifiedAt: new Date().toISOString(),
  baseUrl,
  projectId: process.env.DATOOL_PROJECT_ID,
  threadId,
  turnId: receipt.turnId,
  traceId: trace.id,
  sessionId: trace.sessionId,
  spanCount: trace.spans.length,
  llmCalls: trace.spans.filter((s) => s.kind === "llm").length,
  toolCalls: tools.length,
  failedTools: tools.filter((s) => s.status === "errored").length,
  inputTokens: usage.input_tokens,
  outputTokens: usage.output_tokens,
  cachedInputTokens: usage.cached_input_tokens,
  output: trace.output,
  workspace,
  stateDir,
  checks: [
    "real terminal execution and file output",
    "expected tool failure and recovery",
    "authenticated HTTP persistence",
    "full saved conversation",
    "per-request usage equals Codex turn total",
    "warm-up excluded",
    "model context and response items",
  ],
}
// Resume the same actual conversation, then verify session identity and delta usage.
const second = await run([
  "--ignore-user-config",
  "--skip-git-repo-check",
  "--sandbox",
  "read-only",
  "--json",
  "resume",
  threadId,
  "Datool follow-up canary: run one terminal command to read result.json and print DATOOL_SECOND_TURN=21. Finish with exactly DATOOL_SECOND_TURN=21. No network, external tools, credential reads, or file changes.",
])
await writeFile(join(stateDir, "codex-resume-events.jsonl"), second.stdout, {
  mode: 0o600,
})
await writeFile(join(stateDir, "resume.log"), second.stderr, { mode: 0o600 })
assert.equal(
  second.code,
  0,
  `Follow-up capture failed; inspect ${stateDir}/resume.log`
)
const secondReceipt = second.stderr
  .split("\n")
  .flatMap((line) => {
    try {
      const value = JSON.parse(line)
      return value.event === "datool.trace.saved" &&
        value.turnId !== receipt.turnId
        ? [value]
        : []
    } catch {
      return []
    }
  })
  .at(-1)
assert(secondReceipt, "Follow-up turn was not persisted")
const secondTrace = await client.request<TraceDetail>(
  `/api/traces/${secondReceipt.traceId}`
)
assert.equal(secondTrace.sessionId, trace.sessionId)
assert.notEqual(secondTrace.id, trace.id)
assert.equal(secondTrace.output, "DATOOL_SECOND_TURN=21")
assert.equal(secondTrace.attributes["codex.usage.reconciliation"], "matched")
const cumulative = second.stdout
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .find((event) => event.type === "turn.completed")?.usage
assert(cumulative, "Follow-up Codex usage is missing")
for (const [metric, source] of [
  ["usage.input_tokens", "input_tokens"],
  ["usage.output_tokens", "output_tokens"],
  ["usage.cache_read_tokens", "cached_input_tokens"],
])
  assert.equal(
    Number(trace.attributes[metric]) + Number(secondTrace.attributes[metric]),
    cumulative[source],
    "Per-turn sums must match Codex's cumulative session usage"
  )
const replay = await run(["--thread", threadId], "import")
await writeFile(join(stateDir, "replay.log"), replay.stderr, { mode: 0o600 })
assert.equal(replay.code, 0, "Restart replay failed")
assert.deepEqual(
  JSON.parse(replay.stdout).saved,
  [],
  "Unchanged replay must not duplicate or reupload traces"
)
const secondAfterReplay = await client.request<TraceDetail>(
  `/api/traces/${secondTrace.id}`
)
assert.equal(secondAfterReplay.spans.length, secondTrace.spans.length)
Object.assign(result, {
  secondTurn: {
    traceId: secondTrace.id,
    turnId: secondReceipt.turnId,
    spanCount: secondTrace.spans.length,
    inputTokens: secondTrace.attributes["usage.input_tokens"],
    outputTokens: secondTrace.attributes["usage.output_tokens"],
    cachedInputTokens: secondTrace.attributes["usage.cache_read_tokens"],
    output: secondTrace.output,
  },
  cumulativeUsage: cumulative,
})
result.checks.push(
  "two real turns in one session",
  "per-turn usage sums match Codex cumulative usage",
  "restart replay skips unchanged snapshots"
)
result.verifiedAt = new Date().toISOString()
await writeFile(
  join(stateDir, "verification.json"),
  JSON.stringify(result, null, 2) + "\n",
  { mode: 0o600 }
)
console.log(JSON.stringify(result, null, 2))
