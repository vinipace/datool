import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams,
} from "node:child_process"
import { existsSync } from "node:fs"
import { delimiter, dirname, join } from "node:path"

import type {
  DatasetItemForEvaluation,
  EvaluatorRunErrorKind,
  EvaluatorRunResult,
  JsonObject,
  TraceForEvaluation,
} from "@/src/lib/tracer/contracts"

const DEFAULT_TIMEOUT_MS = 1_000
const MAX_INPUT_BYTES = 1024 * 1024
const MAX_OUTPUT_BYTES = 32 * 1024
const MAX_TIMEOUT_MS = 5_000
const MEMORY_LIMIT_MB = 32
const MINIMUM_NODE_MAJOR = 22
const MINIMUM_NODE_MINOR = 13
const TIMEOUT_GRACE_MS = 150

export type RunEvaluatorInput = {
  code: string
  datasetItem?: DatasetItemForEvaluation | null
  timeoutMs?: number
  trace: TraceForEvaluation
}

type WorkerSuccess = {
  ok: true
  result: {
    metadata: JsonObject
    passed: boolean | null
    reasoning?: string
    score: number
  }
}

type WorkerFailure = {
  error: {
    kind: EvaluatorRunErrorKind
    message: string
  }
  ok: false
}

type WorkerMessage = WorkerFailure | WorkerSuccess

type RuntimeCheck =
  | { binary: string; ok: true }
  | { message: string; ok: false }

let runtimeCheck: Promise<RuntimeCheck> | undefined
let pythonRuntimeCheck: Promise<RuntimeCheck> | undefined

// Keep the worker as a Node entrypoint. Next's asset URL transform would turn
// import.meta.url into a public asset URL that cannot be passed to spawn.
const workerPath = join(process.cwd(), "src/server/sandbox/evaluator-worker.mjs")
const pythonWorkerPath = join(process.cwd(), "src/server/sandbox/python-evaluator-worker.py")
const clearedEnvironment = Object.create(null) as NodeJS.ProcessEnv

function failed(
  kind: EvaluatorRunErrorKind,
  message: string,
): EvaluatorRunResult {
  return {
    error: { kind, message },
    passed: null,
    score: null,
  }
}

function normalizeTimeout(timeoutMs: number | undefined) {
  if (timeoutMs === undefined) {
    return DEFAULT_TIMEOUT_MS
  }

  if (!Number.isFinite(timeoutMs) || timeoutMs < 10) {
    return null
  }

  return Math.min(Math.floor(timeoutMs), MAX_TIMEOUT_MS)
}

function findNodeOnPath() {
  const executable = process.platform === "win32" ? "node.exe" : "node"

  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue
    }

    const candidate = join(directory, executable)
    if (existsSync(candidate)) {
      return candidate
    }
  }

  return null
}

export function resolveNodeBinary() {
  const configured = process.env.DATOOL_SANDBOX_NODE_BINARY?.trim()
  if (configured) {
    return configured
  }

  if (process.release?.name === "node" && !process.versions.bun) {
    return process.execPath
  }

  return findNodeOnPath()
}

function executeProbe(binary: string, args: string[], env = clearedEnvironment) {
  return new Promise<{ exitCode: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn(binary, args, {
        cwd: dirname(workerPath),
        env,
        stdio: ["ignore", "pipe", "pipe"],
      }) as unknown as ChildProcess
      const chunks: Buffer[] = []
      let size = 0

      const collect = (chunk: Buffer) => {
        size += chunk.length
        if (size <= 4_096) {
          chunks.push(chunk)
        }
      }

      child.stdout?.on("data", collect)
      child.stderr?.on("data", collect)
      child.once("error", reject)
      child.once("close", (exitCode) => {
        resolve({ exitCode, output: Buffer.concat(chunks).toString("utf8") })
      })
    },
  )
}

async function checkRuntime(): Promise<RuntimeCheck> {
  const binary = resolveNodeBinary()
  if (!binary) {
    return {
      message:
        "A Node.js runtime is required for local evaluators. Set DATOOL_SANDBOX_NODE_BINARY to an absolute Node.js path when running Datool under Bun.",
      ok: false,
    }
  }

  try {
    const versionProbe = await executeProbe(binary, ["--version"])
    const version = versionProbe.output.match(/v(\d+)\.(\d+)\.(\d+)/)

    if (
      versionProbe.exitCode !== 0 ||
      !version ||
      Number(version[1]) < MINIMUM_NODE_MAJOR ||
      (Number(version[1]) === MINIMUM_NODE_MAJOR &&
        Number(version[2]) < MINIMUM_NODE_MINOR)
    ) {
      return {
        message:
          "Local evaluators require Node.js 22.13 or later with the Permission Model enabled.",
        ok: false,
      }
    }

    const permissionProbe = await executeProbe(binary, [
      "--permission",
      "--eval",
      "process.stdout.write('permission-ok')",
    ])

    if (
      permissionProbe.exitCode !== 0 ||
      !permissionProbe.output.includes("permission-ok")
    ) {
      return {
        message:
          "The configured Node.js runtime does not support the required --permission flag.",
        ok: false,
      }
    }

    return { binary, ok: true }
  } catch (error) {
    return {
      message:
        error instanceof Error
          ? `Could not start the local evaluator runtime: ${error.message}`
          : "Could not start the local evaluator runtime.",
      ok: false,
    }
  }
}

function getRuntimeCheck() {
  runtimeCheck ??= checkRuntime()
  return runtimeCheck
}

async function checkPythonRuntime(): Promise<RuntimeCheck> {
  const configured = process.env.DATOOL_SANDBOX_PYTHON_BINARY?.trim()
  const candidates = configured ? [configured] : (process.env.PATH ?? "")
    .split(delimiter).filter(Boolean).map((directory) => join(directory, "python3"))
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      // Resolve version-manager shims before starting the worker with no environment.
      const probe = await executeProbe(candidate, ["-I", "-S", "-c",
        "import sys; assert sys.version_info >= (3, 9); print(sys.executable)"], Object.assign(Object.create(null), { PATH: process.env.PATH }))
      const binary = probe.output.trim()
      if (probe.exitCode === 0 && existsSync(binary)) return { ok: true, binary }
    } catch { /* Try the next installed runtime. */ }
  }
  return { ok: false, message: "Python 3.9+ is required for Python scorers. Install Python or set DATOOL_SANDBOX_PYTHON_BINARY to its absolute path." }
}

function parseWorkerMessage(output: string): WorkerMessage | null {
  try {
    const message = JSON.parse(output) as unknown
    if (!message || typeof message !== "object" || !("ok" in message)) {
      return null
    }

    return message as WorkerMessage
  } catch {
    return null
  }
}

function toPayload(input: RunEvaluatorInput, timeoutMs: number) {
  try {
    const payload = JSON.stringify({
      code: input.code,
      datasetItem: input.datasetItem ?? null,
      timeoutMs,
      trace: input.trace,
    })

    if (Buffer.byteLength(payload, "utf8") > MAX_INPUT_BYTES) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

async function executeWorker(
  binary: string,
  payload: string,
  timeoutMs: number,
  language: "javascript" | "python" = "javascript",
): Promise<EvaluatorRunResult> {
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      language === "python" ? ["-I", "-S", "-B", pythonWorkerPath] : [
        `--max-old-space-size=${MEMORY_LIMIT_MB}`,
        "--permission",
        `--allow-fs-read=${workerPath}`,
        workerPath,
      ],
      {
        cwd: dirname(workerPath),
        env: clearedEnvironment,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ) as unknown as ChildProcessWithoutNullStreams
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputSize = 0
    let outputExceeded = false
    let settled = false
    let timedOut = false

    const settle = (result: EvaluatorRunResult) => {
      if (settled) {
        return
      }

      settled = true
      clearTimeout(killTimer)
      resolve(result)
    }

    const killTimer = setTimeout(() => {
      timedOut = true
      child.kill("SIGKILL")
    }, timeoutMs + TIMEOUT_GRACE_MS)

    const collect = (chunks: Buffer[]) => (chunk: Buffer) => {
      outputSize += chunk.length
      if (outputSize > MAX_OUTPUT_BYTES) {
        outputExceeded = true
        child.kill("SIGKILL")
        return
      }

      chunks.push(chunk)
    }

    child.stdout.on("data", collect(stdout))
    child.stderr.on("data", collect(stderr))
    child.once("error", (error) => {
      settle(
        failed(
          "sandbox",
          `Could not start the evaluator process: ${error.message}`,
        ),
      )
    })
    child.once("close", (exitCode) => {
      if (timedOut) {
        settle(failed("timeout", "Evaluator exceeded its wall-clock timeout"))
        return
      }

      if (outputExceeded) {
        settle(
          failed("sandbox", "Evaluator exceeded the 32 KB stdout/stderr limit"),
        )
        return
      }

      const parsed = parseWorkerMessage(Buffer.concat(stdout).toString("utf8"))
      if (!parsed) {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim()
        settle(
          failed(
            "protocol",
            diagnostic
              ? `Evaluator returned no valid result: ${diagnostic.slice(0, 500)}`
              : `Evaluator returned no valid result (exit ${exitCode ?? "unknown"})`,
          ),
        )
        return
      }

      if (!parsed.ok) {
        settle(failed(parsed.error.kind, parsed.error.message))
        return
      }

      settle({
        metadata: parsed.result.metadata,
        passed: parsed.result.passed,
        ...(parsed.result.reasoning
          ? { reasoning: parsed.result.reasoning }
          : {}),
        score: parsed.result.score,
      })
    })

    child.stdin.on("error", () => {
      // The process close handler reports the normalized sandbox failure.
    })
    child.stdin.end(payload)
  })
}

/**
 * Executes one trusted-local JavaScript evaluator in a short-lived Node.js
 * process. This is deliberately not an app-server evaluator API: callers must
 * persist evaluator code separately and invoke this runner from a trusted
 * local backend process.
 */
export async function runEvaluator(input: RunEvaluatorInput): Promise<EvaluatorRunResult> {
  return runLocalEvaluator(input, "javascript")
}

/** Python follows the same trusted-local execution boundary as JavaScript. */
export async function runPythonEvaluator(input: RunEvaluatorInput): Promise<EvaluatorRunResult> {
  return runLocalEvaluator(input, "python")
}

async function runLocalEvaluator(
  input: RunEvaluatorInput,
  language: "javascript" | "python",
): Promise<EvaluatorRunResult> {
  if (typeof input.code !== "string" || input.code.trim().length === 0) {
    return failed("validation", "Evaluator code must be a non-empty string")
  }

  const timeoutMs = normalizeTimeout(input.timeoutMs)
  if (timeoutMs === null) {
    return failed(
      "validation",
      `Evaluator timeout must be at least 10 ms and no more than ${MAX_TIMEOUT_MS} ms`,
    )
  }

  const payload = toPayload(input, timeoutMs)
  if (!payload) {
    return failed(
      "validation",
      `Evaluator input must be JSON serializable and at most ${MAX_INPUT_BYTES / 1024} KB`,
    )
  }

  const runtime = await (language === "python"
    ? (pythonRuntimeCheck ??= checkPythonRuntime())
    : getRuntimeCheck())
  if (!runtime.ok) {
    return failed("sandbox", runtime.message)
  }

  return executeWorker(runtime.binary, payload, timeoutMs, language)
}

export const localEvaluatorSandboxLimits = {
  maxInputBytes: MAX_INPUT_BYTES,
  maxOutputBytes: MAX_OUTPUT_BYTES,
  maxTimeoutMs: MAX_TIMEOUT_MS,
  memoryLimitMb: MEMORY_LIMIT_MB,
  runtime: "Node.js 22.13+ with --permission",
} as const
