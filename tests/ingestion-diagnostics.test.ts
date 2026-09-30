import { expect, test } from "bun:test"
import {
  IngestionDependencyPendingError,
  IngestionPersistenceError,
  IngestionRejectedError,
  describeIngestionError,
  diagnosticSummary,
  ingestionFailureCode,
  isRecordLimitFailure,
  readRetainedDiagnostic,
} from "../src/server/ingestion/diagnostics"
import { TracerError } from "../src/server/tracer/errors"

test("ingestion diagnostics distinguish missing predecessors, database errors, and Redis capacity", () => {
  expect(ingestionFailureCode(new IngestionDependencyPendingError())).toBe(
    "DEPENDENCY_PENDING"
  )
  const driver = Object.assign(new Error("password and SQL parameters"), {
    code: "23503",
    detail: "private payload",
  })
  const wrapped = new TracerError(
    "INTERNAL_ERROR",
    "Failed query: private SQL",
    { cause: new Error("Drizzle query", { cause: driver }) }
  )
  expect(ingestionFailureCode(wrapped)).toBe("POSTGRES_23503")
  const redis = Object.assign(
    new Error("OOM command not allowed when used memory > maxmemory"),
    { name: "ReplyError", command: { args: ["private payload"] } }
  )
  expect(ingestionFailureCode(redis)).toBe("REDIS_OOM")
  expect(
    ingestionFailureCode(
      Object.assign(new Error("private host"), { code: "ECONNREFUSED" })
    )
  ).toBe("ECONNREFUSED")
})

test("unknown diagnostics retain source context and a stable fingerprint while withholding arbitrary messages and fields", () => {
  const secret = "private-customer-prompt"
  const cause = new TypeError(
    `${secret}\n    at injected (/app/src/${secret}.ts:1:1)`
  )
  cause.stack = `${cause.toString()}\n    at persist (/app/src/server/ingestion/persist.ts:42:10)\n    at driver (/app/node_modules/pg/lib/client.js:100:20)`
  const error = Object.assign(
    new Error("postgres://user:password@host/database", { cause }),
    { sql: secret, parameters: [secret], token: secret }
  )
  const result = describeIngestionError(error, "apply_event")
  const output = JSON.stringify(result)
  expect(result.code).toBe("UNKNOWN")
  expect(result.causes[1]).toEqual({
    type: "TypeError",
    code: "UNKNOWN",
    frames: [
      "src/server/ingestion/persist.ts:42:10",
      "node_modules/pg/lib/client.js:100:20",
    ],
  })
  expect(result.fingerprint).toBe(
    describeIngestionError(error, "apply_event").fingerprint
  )
  expect(result.fingerprint).not.toBe(
    describeIngestionError(error, "save_receipt").fingerprint
  )
  expect(output).not.toContain(secret)
  expect(output).not.toContain("password")
  expect(diagnosticSummary(result)).toContain("source frames")
  const retained = new IngestionPersistenceError(error, "apply_event")
  expect(readRetainedDiagnostic(retained.message)).toEqual(result)
  expect(retained.stack).not.toContain(secret)
  expect(
    readRetainedDiagnostic(JSON.stringify({ ...result, password: secret }))
  ).toBeNull()
  expect(readRetainedDiagnostic("legacy private error")).toBeNull()
})

test("quota recovery recognizes structured failures and legacy retained jobs without confusing other 429 errors", () => {
  const quota = new TracerError(
    "VALIDATION_ERROR",
    "Monthly record limit reached.",
    {
      status: 429,
      details: { reason: "RECORD_LIMIT_REACHED", private: "customer data" },
    }
  )
  const error = new IngestionRejectedError(quota, "apply_event")
  expect(isRecordLimitFailure(error.message)).toBe(true)
  expect(
    isRecordLimitFailure("Monthly record limit reached. Upgrade your plan.")
  ).toBe(true)
  expect(
    isRecordLimitFailure(
      new IngestionRejectedError(
        new TracerError("READ_BUSY", "Busy", { status: 429 }),
        "apply_event"
      ).message
    )
  ).toBe(false)
  expect(error.message).not.toContain("customer data")
  expect(readRetainedDiagnostic(error.message)).toMatchObject({
    code: "VALIDATION_ERROR",
    status: 429,
    detail: "RECORD_LIMIT_REACHED",
    retryable: false,
  })
})

test("retained persistence errors contain only safe diagnostics, never raw causes", () => {
  const error = new IngestionPersistenceError(
    new Error("postgres://secret@host/private; SQL: customer input")
  )
  expect(error.message).toContain("UNKNOWN")
  expect(error.cause).toBeUndefined()
  expect(error.stack).not.toContain("customer input")
  expect(ingestionFailureCode(error)).toBe("UNKNOWN")
  expect(
    ingestionFailureCode(
      Object.assign(new Error("private payload"), { code: "private payload" })
    )
  ).toBe("UNKNOWN")
  expect(
    ingestionFailureCode(
      Object.assign(new Error("private payload"), { name: "ReplyError" })
    )
  ).toBe("UNKNOWN")
  const cyclic = new Error("private payload")
  cyclic.cause = cyclic
  expect(ingestionFailureCode(cyclic)).toBe("UNKNOWN")
})
