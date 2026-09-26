import { Script, createContext } from "node:vm"

const MAX_CODE_BYTES = 128 * 1024
const MAX_RESULT_BYTES = 16 * 1024
const MAX_TIMEOUT_MS = 5_000

class EvaluatorValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = "EvaluatorValidationError"
  }
}

class EvaluatorTimeoutError extends Error {
  constructor(message) {
    super(message)
    this.name = "EvaluatorTimeoutError"
  }
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function errorKind(error) {
  if (error instanceof EvaluatorTimeoutError) {
    return "timeout"
  }

  if (error instanceof EvaluatorValidationError) {
    return "validation"
  }

  const message = getErrorMessage(error)
  if (message.startsWith("DATOOL_VALIDATION:")) {
    return "validation"
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT"
  ) {
    return "timeout"
  }

  return "runtime"
}

function getErrorMessage(error) {
  if (error instanceof Error && error.message) {
    return error.message
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message
  }

  return "Evaluator failed without an error message"
}

function errorMessage(error) {
  return getErrorMessage(error)
    .replace(/^DATOOL_VALIDATION:/, "")
    .slice(0, 1_000)
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateResult(value) {
  if (!isPlainObject(value)) {
    throw new EvaluatorValidationError(
      "Evaluator must return a JSON object with a finite score between 0 and 1",
    )
  }

  const supportedKeys = new Set([
    "name",
    "metadata",
    "score",
    "passed",
    "label",
    "reason",
    "metrics",
  ])
  const unsupportedKeys = Object.keys(value).filter(
    (key) => !supportedKeys.has(key),
  )

  if (unsupportedKeys.length > 0) {
    throw new EvaluatorValidationError(
      `Evaluator result contains unsupported field(s): ${unsupportedKeys.join(", ")}. Use reason, not reasoning.`,
    )
  }

  const booleanScore = typeof value.score === "boolean" ? value.score : undefined
  if (booleanScore !== undefined) value.score = booleanScore ? 1 : 0

  if (typeof value.score !== "number" || !Number.isFinite(value.score)) {
    throw new EvaluatorValidationError(
      "Evaluator result score must be a finite number between 0 and 1",
    )
  }

  if (value.score < 0 || value.score > 1) {
    throw new EvaluatorValidationError(
      "Evaluator result score must be between 0 and 1",
    )
  }

  if (value.passed !== undefined && typeof value.passed !== "boolean") {
    throw new EvaluatorValidationError(
      "Evaluator result passed must be a boolean when provided",
    )
  }

  if (value.label !== undefined && typeof value.label !== "string") {
    throw new EvaluatorValidationError(
      "Evaluator result label must be a string when provided",
    )
  }

  if (value.reason !== undefined && typeof value.reason !== "string") {
    throw new EvaluatorValidationError(
      "Evaluator result reason must be a string when provided",
    )
  }

  if (value.metrics !== undefined && !isPlainObject(value.metrics)) {
    throw new EvaluatorValidationError(
      "Evaluator result metrics must be a JSON object when provided",
    )
  }

  if (value.name !== undefined && (typeof value.name !== "string" || !value.name.trim())) {
    throw new EvaluatorValidationError("Evaluator result name must be non-empty")
  }
  if (value.metadata !== undefined && !isPlainObject(value.metadata)) {
    throw new EvaluatorValidationError("Evaluator result metadata must be a JSON object")
  }
  const metadata = { ...value.metadata }
  if (value.name !== undefined) metadata.name = value.name.trim()
  if (booleanScore !== undefined) metadata.booleanScore = booleanScore

  if (value.label !== undefined) {
    metadata.label = value.label
  }

  if (value.metrics !== undefined) {
    metadata.metrics = value.metrics
  }

  return {
    metadata,
    passed: value.passed ?? null,
    reasoning: value.reason,
    score: value.score,
  }
}

function readRequest() {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0

    process.stdin.on("data", (chunk) => {
      size += chunk.length
      if (size > MAX_CODE_BYTES + 1024 * 1024) {
        reject(new EvaluatorValidationError("Evaluator request is too large"))
        process.stdin.destroy()
        return
      }

      chunks.push(chunk)
    })
    process.stdin.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch {
        reject(
          new EvaluatorValidationError("Evaluator request is not valid JSON"),
        )
      }
    })
    process.stdin.on("error", reject)
  })
}

function awaitWithTimeout(value, timeoutMs) {
  let timer

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new EvaluatorTimeoutError("Evaluator exceeded its wall-clock timeout"),
      )
    }, timeoutMs)
  })

  return Promise.race([Promise.resolve(value), timeout]).finally(() => {
    clearTimeout(timer)
  })
}

function buildContext(payloadJson) {
  const sandbox = Object.create(null)

  for (const key of [
    "Buffer",
    "console",
    "fetch",
    "module",
    "process",
    "require",
    "setImmediate",
    "setInterval",
    "setTimeout",
    "WebSocket",
    "XMLHttpRequest",
  ]) {
    Object.defineProperty(sandbox, key, {
      configurable: false,
      enumerable: false,
      value: undefined,
      writable: false,
    })
  }

  Object.defineProperty(sandbox, "__datoolPayloadJson", {
    configurable: false,
    enumerable: false,
    value: payloadJson,
    writable: false,
  })

  return createContext(sandbox, {
    codeGeneration: {
      strings: false,
      wasm: false,
    },
    name: "datool-evaluator",
  })
}

async function run(request) {
  if (!isPlainObject(request)) {
    throw new EvaluatorValidationError("Evaluator request must be an object")
  }

  if (typeof request.code !== "string" || request.code.trim().length === 0) {
    throw new EvaluatorValidationError(
      "Evaluator code must be a non-empty string",
    )
  }

  if (Buffer.byteLength(request.code, "utf8") > MAX_CODE_BYTES) {
    throw new EvaluatorValidationError(
      "Evaluator code exceeds the 128 KB limit",
    )
  }

  const timeoutMs = Math.min(
    Math.max(Number(request.timeoutMs) || 1_000, 10),
    MAX_TIMEOUT_MS,
  )
  const payloadJson = JSON.stringify({
    datasetItem: request.datasetItem ?? null,
    trace: request.trace,
  })
  const context = buildContext(payloadJson)

  const definition = new Script(
    `"use strict";\n${request.code}\n;\n` +
      `if (typeof evaluate !== "function") {\n` +
      `  throw new Error("DATOOL_VALIDATION:Evaluator code must define evaluate({ trace, datasetItem })");\n` +
      `}\n` +
      `globalThis.__datoolEvaluate = evaluate;\n` +
      `globalThis.__datoolInput = JSON.parse(globalThis.__datoolPayloadJson);`,
    { filename: "evaluator.js" },
  )

  definition.runInContext(context, { timeout: timeoutMs })

  const invocation = new Script(
    `(async () => {\n` +
      `  const value = await globalThis.__datoolEvaluate(globalThis.__datoolInput);\n` +
      `  return JSON.stringify(value);\n` +
      `})()`,
    { filename: "evaluator-invocation.js" },
  )

  const resultJson = await awaitWithTimeout(
    invocation.runInContext(context, { timeout: timeoutMs }),
    timeoutMs,
  )

  if (typeof resultJson !== "string") {
    throw new EvaluatorValidationError(
      "Evaluator result must be JSON serializable",
    )
  }

  if (Buffer.byteLength(resultJson, "utf8") > MAX_RESULT_BYTES) {
    throw new EvaluatorValidationError(
      "Evaluator result exceeds the 16 KB limit",
    )
  }

  let result
  try {
    result = JSON.parse(resultJson)
  } catch {
    throw new EvaluatorValidationError("Evaluator result must be valid JSON")
  }

  return validateResult(result)
}

try {
  const request = await readRequest()
  const result = await run(request)
  write({ ok: true, result })
} catch (error) {
  write({
    error: {
      kind: errorKind(error),
      message: errorMessage(error),
    },
    ok: false,
  })
}
