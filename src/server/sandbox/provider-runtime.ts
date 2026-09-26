import { spawn, execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { EvaluatorRunResult } from "@/src/lib/tracer/contracts"
import type { SandboxCredentials } from "@/src/lib/sandbox-providers"

export type SandboxJob = {
  language: "javascript" | "python"
  payload: string
  timeoutMs: number
  deadlineMs?: number
  onModalCreated?: (sandboxId: string) => Promise<void>
  onModalUsage?: (usage: {
    sandboxId: string
    allocatedMs: number
  }) => Promise<void>
}
const MAX_OUTPUT_BYTES = 32 * 1024
const STARTUP_TIMEOUT_MS = 45_000
const remaining = (job: SandboxJob, limit: number) =>
  Math.max(
    1,
    Math.min(
      limit,
      job.deadlineMs === undefined ? limit : job.deadlineMs - Date.now()
    )
  )
export const sandboxImages = {
  javascript: "node:22-bookworm-slim",
  python: "python:3.13-slim",
} as const
class OutputLimitError extends Error {}
export const sandboxFailure = (
  kind: "sandbox" | "timeout" | "protocol" | "validation",
  message: string
): EvaluatorRunResult => ({
  score: null,
  passed: null,
  error: { kind, message },
})

const workerMessageSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    result: z.object({
      score: z.number().min(0).max(1),
      passed: z.boolean().nullable(),
      reasoning: z.string().optional(),
      metadata: z.record(z.string(), z.json()),
    }),
  }),
  z.object({
    ok: z.literal(false),
    error: z.object({
      kind: z.enum(["runtime", "validation", "timeout", "sandbox", "protocol"]),
      message: z.string().max(4096),
    }),
  }),
])

export function decodeSandboxResult(
  stdout: string,
  exitCode: number | null
): EvaluatorRunResult {
  if (exitCode === 124 || exitCode === 137)
    return sandboxFailure(
      "timeout",
      "Scorer exceeded its execution or memory limit."
    )
  if (exitCode === 125 || exitCode === 126 || exitCode === 127)
    throw new Error("Sandbox runtime could not start.")
  let message: z.infer<typeof workerMessageSchema>
  try {
    message = workerMessageSchema.parse(JSON.parse(stdout))
  } catch {
    return sandboxFailure(
      "protocol",
      "Sandbox returned an invalid scorer result."
    )
  }
  if (!message.ok) return { score: null, passed: null, error: message.error }
  if (exitCode !== 0)
    return sandboxFailure("sandbox", "Scorer process exited unexpectedly.")
  return message.result
}

async function workerCommand(job: SandboxJob) {
  const file =
    job.language === "python"
      ? "python-evaluator-worker.py"
      : "evaluator-worker.mjs"
  const source = await readFile(
    join(process.cwd(), "src/server/sandbox", file),
    "utf8"
  )
  return [
    "timeout",
    "--signal=TERM",
    "--kill-after=1s",
    `${(job.timeoutMs + 500) / 1000}s`,
    "env",
    "-i",
    "PATH=/usr/local/bin:/usr/bin:/bin",
    ...(job.language === "python"
      ? ["python3", "-I", "-S", "-B", "-c", source]
      : [
          "node",
          "--max-old-space-size=32",
          "--permission",
          "--input-type=module",
          "--eval",
          source,
        ]),
  ]
}

function outputCollector() {
  let size = 0
  const stdout: Buffer[] = []
  return {
    add(stream: string, chunk: string | Uint8Array) {
      size +=
        typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength
      if (size > MAX_OUTPUT_BYTES) throw new OutputLimitError()
      if (stream === "stdout") stdout.push(Buffer.from(chunk))
    },
    result: () => Buffer.concat(stdout).toString("utf8"),
  }
}

async function runContainer(job: SandboxJob): Promise<EvaluatorRunResult> {
  const command = await workerCommand(job)
  const name = `datool-scorer-${randomUUID()}`
  const docker = process.env.DATOOL_SANDBOX_DOCKER_BINARY?.trim() || "docker"
  const output = outputCollector()
  const directory = await mkdtemp(join(tmpdir(), "datool-scorer-"))
  const containerIdFile = join(directory, "container-id")
  try {
    return await new Promise<EvaluatorRunResult>((resolve, reject) => {
      const child = spawn(
        /* turbopackIgnore: true */
        docker,
        [
          "run",
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--cidfile",
          containerIdFile,
          "--interactive",
          "--init",
          "--network=none",
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65534:65534",
          "--cpus=1",
          "--memory=128m",
          "--memory-swap=128m",
          "--pids-limit=64",
          "--tmpfs=/tmp:rw,noexec,nosuid,size=16m",
          sandboxImages[job.language],
          ...command,
        ],
        { stdio: ["pipe", "pipe", "pipe"] }
      )
      let outputExceeded = false
      const timer = setTimeout(
        () => {
          child.kill("SIGKILL")
          reject(new Error("Container startup timed out."))
        },
        remaining(job, STARTUP_TIMEOUT_MS + job.timeoutMs)
      )
      const collect = (stream: string) => (chunk: Buffer) => {
        try {
          output.add(stream, chunk)
        } catch {
          outputExceeded = true
          child.kill("SIGKILL")
        }
      }
      child.stdout.on("data", collect("stdout"))
      child.stderr.on("data", collect("stderr"))
      child.stdin.on("error", () => {
        /* close reports the outcome */
      })
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", async (code) => {
        clearTimeout(timer)
        try {
          // Docker can exit 1 (also a valid scorer exit code) before creating a
          // container. The CLI's ID file distinguishes startup from execution.
          await readFile(containerIdFile, "utf8")
          if (outputExceeded) {
            resolve(
              sandboxFailure(
                "sandbox",
                "Scorer exceeded the 32 KB output limit."
              )
            )
            return
          }
          resolve(decodeSandboxResult(output.result(), code))
        } catch (error) {
          reject(error)
        }
      })
      child.stdin.end(job.payload)
    })
  } finally {
    // Killing the Docker client alone does not stop the container.
    await new Promise<void>((resolve) =>
      execFile(
        /* turbopackIgnore: true */ docker,
        ["rm", "--force", name],
        { timeout: 5000 },
        () => resolve()
      )
    )
    await rm(directory, { recursive: true, force: true })
  }
}

async function runVercel(
  config: Extract<SandboxCredentials, { provider: "vercel" }>,
  job: SandboxJob
) {
  const { Sandbox } = await import("@vercel/sandbox")
  const command = await workerCommand(job)
  const sandbox = await Sandbox.create({
    token: config.apiKey,
    teamId: config.teamId,
    projectId: config.projectId,
    image:
      job.language === "python"
        ? "vercel/sandbox/universal"
        : "vercel/sandbox/node:22",
    persistent: false,
    networkPolicy: "deny-all",
    timeout: 30_000,
    signal: AbortSignal.timeout(remaining(job, STARTUP_TIMEOUT_MS)),
  })
  try {
    const signal = AbortSignal.timeout(remaining(job, 15_000 + job.timeoutMs))
    await sandbox.fs.writeFile("/tmp/datool-input.json", job.payload, {
      signal,
    })
    const process = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", 'exec "$@" < /tmp/datool-input.json', "datool", ...command],
      detached: true,
      timeoutMs: job.timeoutMs + 2000,
      signal,
    })
    const output = outputCollector()
    for await (const log of process.logs({ signal }))
      output.add(log.stream, log.data)
    const finished = await process.wait({ signal })
    return decodeSandboxResult(output.result(), finished.exitCode)
  } finally {
    await sandbox
      .stop({ signal: AbortSignal.timeout(5000) })
      .catch(() => undefined)
  }
}

async function readStream(
  stream: ReadableStream<string>,
  collect: (chunk: string) => void
) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      collect(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function withDeadline<T>(
  operation: Promise<T>,
  milliseconds: number,
  lateCleanup?: (value: T) => Promise<unknown>
): Promise<T> {
  let expired = false
  let timer: ReturnType<typeof setTimeout>
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      expired = true
      reject(new Error("Sandbox provider timed out."))
    }, milliseconds)
  })
  const observed = operation.then(async (value) => {
    if (expired && lateCleanup) await lateCleanup(value).catch(() => undefined)
    return value
  })
  try {
    return await Promise.race([observed, deadline])
  } finally {
    clearTimeout(timer!)
  }
}

async function runModal(
  config: Extract<SandboxCredentials, { provider: "modal" }>,
  job: SandboxJob
) {
  const { ModalClient } = await import("modal")
  const client = new ModalClient({
    tokenId: config.tokenId,
    tokenSecret: config.tokenSecret,
    timeoutMs: remaining(job, 15000),
    maxRetries: 0,
  })
  try {
    const command = await workerCommand(job)
    const app = await withDeadline(
      client.apps.fromName("datool-scorers", {
        createIfMissing: true,
      }),
      remaining(job, 15000)
    )
    const image = client.images.fromRegistry(sandboxImages[job.language])
    const sandbox = await withDeadline(
      client.sandboxes.create(app, image, {
        // Explicitly handle termination: the Python image's default idle
        // process otherwise remains alive through Modal's shutdown grace period.
        command: ["/bin/sh", "-c", "trap 'exit 0' TERM INT; sleep 30 & wait"],
        blockNetwork: true,
        timeoutMs: 30_000,
        cpu: 1,
        cpuLimit: 1,
        // 128 MiB stalls even trivial Node scorers on Modal. Leave runtime
        // headroom while retaining the worker's own heap/address-space limits.
        memoryMiB: 256,
        memoryLimitMiB: 256,
      }),
      remaining(job, STARTUP_TIMEOUT_MS),
      async (late) => {
        try {
          await job.onModalCreated?.(late.sandboxId)
        } finally {
          try {
            await late.terminate({ wait: true })
          } finally {
            late.detach()
          }
        }
      }
    )
    const allocatedAt = performance.now()
    try {
      await job.onModalCreated?.(sandbox.sandboxId)
      const process = await withDeadline(
        sandbox.exec(command, {
          timeoutMs: job.timeoutMs + 2000,
        }),
        remaining(job, 15000)
      )
      const output = outputCollector()
      const [, , , exitCode] = await withDeadline(
        Promise.all([
          (async () => {
            await process.stdin.writeText(job.payload)
            await process.stdin.close()
          })(),
          readStream(process.stdout, (chunk) => output.add("stdout", chunk)),
          readStream(process.stderr, (chunk) => output.add("stderr", chunk)),
          process.wait(),
        ]),
        remaining(job, 15000 + job.timeoutMs)
      )
      return decodeSandboxResult(output.result(), exitCode)
    } finally {
      try {
        await withDeadline(sandbox.terminate({ wait: true }), 5000)
        await job.onModalUsage?.({
          sandboxId: sandbox.sandboxId,
          allocatedMs: performance.now() - allocatedAt,
        })
      } catch {
        /* A pending credit reservation is retained for reconciliation. */
      }
      sandbox.detach()
    }
  } finally {
    client.close()
  }
}

export async function executeSandboxProvider(
  config: SandboxCredentials,
  job: SandboxJob
): Promise<EvaluatorRunResult> {
  try {
    if (config.provider === "datool")
      throw new Error("Datool Sandbox requires a funded project execution.")
    if (config.provider === "local") return await runContainer(job)
    if (config.provider === "vercel") return await runVercel(config, job)
    return await runModal(config, job)
  } catch (error) {
    if (error instanceof OutputLimitError)
      return sandboxFailure(
        "sandbox",
        "Scorer exceeded the 32 KB output limit."
      )
    // SDK errors can include credentials; callers only record the provider ID.
    throw new Error(
      "Sandbox provider is unavailable. Check its configuration and capacity."
    )
  }
}
