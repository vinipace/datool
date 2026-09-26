import { expect, test } from "bun:test"
import { IngestionDependencyPendingError, IngestionPersistenceError, ingestionFailureCode } from "../src/server/ingestion/diagnostics"
import { TracerError } from "../src/server/tracer/errors"

test("ingestion diagnostics distinguish missing predecessors, database errors, and Redis capacity", () => {
  expect(ingestionFailureCode(new IngestionDependencyPendingError())).toBe("DEPENDENCY_PENDING")
  const driver = Object.assign(new Error("password and SQL parameters"), { code: "23503", detail: "private payload" })
  const wrapped = new TracerError("INTERNAL_ERROR", "Failed query: private SQL", { cause: new Error("Drizzle query", { cause: driver }) })
  expect(ingestionFailureCode(wrapped)).toBe("POSTGRES_23503")
  const redis = Object.assign(new Error("OOM command not allowed when used memory > maxmemory"), { name: "ReplyError", command: { args: ["private payload"] } })
  expect(ingestionFailureCode(redis)).toBe("REDIS_OOM")
  expect(ingestionFailureCode(Object.assign(new Error("private host"), { code: "ECONNREFUSED" }))).toBe("ECONNREFUSED")
})

test("retained persistence errors contain only safe diagnostics, never raw causes", () => {
  const error = new IngestionPersistenceError(new Error("postgres://secret@host/private; SQL: customer input"))
  expect(error.message).toContain("UNKNOWN")
  expect(error.cause).toBeUndefined()
  expect(error.stack).not.toContain("customer input")
  expect(ingestionFailureCode(error)).toBe("UNKNOWN")
  expect(ingestionFailureCode(Object.assign(new Error("private payload"), { code: "private payload" }))).toBe("UNKNOWN")
  expect(ingestionFailureCode(Object.assign(new Error("private payload"), { name: "ReplyError" }))).toBe("UNKNOWN")
  const cyclic = new Error("private payload")
  cyclic.cause = cyclic
  expect(ingestionFailureCode(cyclic)).toBe("UNKNOWN")
})
