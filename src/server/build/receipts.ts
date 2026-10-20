import { createHash } from "node:crypto"

import { sql } from "drizzle-orm"

import { canonicalJson } from "@/src/lib/tracer/resource-document"
import { TracerError } from "@/src/server/tracer/errors"
import { scopedTracerTransaction, type TracerDatabase } from "@/src/server/tracer/db"
import type { BuildContext } from "./context"
import { operationId } from "./context"

type ReceiptRow = {
  id: string
  input_hash: string
  status: "pending" | "completed" | "failed"
  result_json: unknown
  error_code: string | null
  error_message: string | null
  lease_expires_at: Date | string | null
}

export type BuildReceiptReservation =
  | { kind: "execute"; id: string }
  | { kind: "replay"; result: unknown }

function inputHash(input: Record<string, unknown>) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex")
}

function decodeJson(value: unknown) {
  if (value === null || value === undefined) return null
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

/**
 * Reserve one operation request before executing a keyed Build mutation.
 *
 * DB-only callers use the in-transaction variant so the receipt and domain
 * mutation commit together. Open-world callers must use their own provider,
 * event or lease idempotency; this table is not a substitute for that.
 */
export async function beginBuildOperationReceipt(
  context: BuildContext,
  operation: string,
  key: string,
  input: Record<string, unknown>,
): Promise<BuildReceiptReservation> {
  return context.database.transaction(async (tx) => {
    const database = scopedTracerTransaction(context.database, tx)
    return beginBuildOperationReceiptInTransaction(
      { ...context, database },
      operation,
      key,
      input,
    )
  })
}

/** Reserve a receipt on an already-open transaction. */
export async function beginBuildOperationReceiptInTransaction(
  context: BuildContext,
  operation: string,
  key: string,
  input: Record<string, unknown>,
): Promise<BuildReceiptReservation> {
  const hash = inputHash(input)
  const database = context.database as TracerDatabase
  const existing = await database.execute<ReceiptRow>(sql`
    SELECT id, input_hash, status, result_json, error_code, error_message,
           lease_expires_at
    FROM build_operation_receipts
    WHERE project_id = ${context.projectId}
      AND operation_name = ${operation}
      AND idempotency_key = ${key}
    FOR UPDATE
  `)
  let row = existing.rows[0]
  if (!row) {
    const id = operationId("build_receipt")
    const inserted = await database.execute<ReceiptRow>(sql`
      INSERT INTO build_operation_receipts
        (id, project_id, operation_name, idempotency_key, input_hash,
         status, actor_id, request_key, lease_expires_at)
      VALUES
        (${id}, ${context.projectId}, ${operation}, ${key}, ${hash},
         'pending', ${context.actorId ?? null}, ${context.requestKey ?? null},
         now() + interval '5 minutes')
      ON CONFLICT (project_id, operation_name, idempotency_key) DO NOTHING
      RETURNING id, input_hash, status, result_json, error_code, error_message,
                lease_expires_at
    `)
    if (inserted.rows[0]) return { kind: "execute", id } as const

    // Another transaction won the insert race. PostgreSQL waits for that
    // transaction before resolving the conflict; re-read its committed row
    // under the same lock before deciding whether to replay or reject.
    const concurrent = await database.execute<ReceiptRow>(sql`
      SELECT id, input_hash, status, result_json, error_code, error_message,
             lease_expires_at
      FROM build_operation_receipts
      WHERE project_id = ${context.projectId}
        AND operation_name = ${operation}
        AND idempotency_key = ${key}
      FOR UPDATE
    `)
    row = concurrent.rows[0]
    if (!row)
      throw new TracerError("CONFLICT", "The Build operation receipt could not be reserved.")
  }
  if (row.input_hash !== hash)
    throw new TracerError(
      "CONFLICT",
      "The idempotency key was already used with different input.",
      {
        details: {
          reason: "IDEMPOTENCY_KEY_REUSED",
          operation,
        },
      },
    )
  if (row.status === "completed")
    return { kind: "replay", result: decodeJson(row.result_json) } as const
  if (row.status === "pending") {
    const recovered = await database.execute<ReceiptRow>(sql`
      UPDATE build_operation_receipts
      SET attempt_count = attempt_count + 1,
          lease_expires_at = now() + interval '5 minutes',
          updated_at = now()
      WHERE id = ${row.id} AND project_id = ${context.projectId}
        AND status = 'pending'
        AND (lease_expires_at IS NULL OR lease_expires_at <= now())
      RETURNING id
    `)
    if (recovered.rows[0]) return { kind: "execute", id: row.id } as const
    throw new TracerError(
      "CONFLICT",
      "This Build operation is already in progress for the supplied idempotency key.",
      {
        details: {
          reason: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
          operation,
          retryable: true,
        },
      },
    )
  }

  // A failed database transaction leaves a retryable receipt. The domain
  // operation receives the same stable key on every retry and can enforce
  // provider-specific idempotency where an external side effect exists.
  await database.execute(sql`
    UPDATE build_operation_receipts
    SET status = 'pending', result_json = NULL,
        error_code = NULL, error_message = NULL,
        attempt_count = attempt_count + 1,
        lease_expires_at = now() + interval '5 minutes', updated_at = now()
    WHERE id = ${row.id} AND project_id = ${context.projectId}
  `)
  return { kind: "execute", id: row.id } as const
}

/** Persist a JSON-safe result so a lost HTTP/MCP response can be replayed. */
export async function completeBuildOperationReceipt(
  context: BuildContext,
  receiptId: string,
  result: unknown,
) {
  const encoded = JSON.stringify(result === undefined ? null : result)
  if (encoded === undefined)
    throw new TracerError("INTERNAL_ERROR", "Build operation returned an unserializable result.")
  const saved = await context.database.execute(sql`
    UPDATE build_operation_receipts
    SET status = 'completed', result_json = ${encoded}::jsonb,
        error_code = NULL, error_message = NULL,
        lease_expires_at = NULL, completed_at = now(), updated_at = now()
    WHERE id = ${receiptId} AND project_id = ${context.projectId}
      AND status = 'pending'
  `)
  if (!saved.rowCount)
    throw new TracerError("CONFLICT", "The Build operation receipt was lost before completion.")
}

/** Mark a failed attempt retryable without retaining stack traces or secrets. */
export async function failBuildOperationReceipt(
  context: BuildContext,
  receiptId: string,
  error: TracerError,
) {
  await context.database.execute(sql`
    UPDATE build_operation_receipts
    SET status = 'failed', error_code = ${error.code},
        error_message = ${error.message.slice(0, 4000)},
        lease_expires_at = NULL,
        updated_at = now()
    WHERE id = ${receiptId} AND project_id = ${context.projectId}
      AND status = 'pending'
  `)
}
