import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  executeBuildOperation,
  registerBuildOperation,
} from "@/src/server/build/bootstrap"
import { TracerError } from "@/src/server/tracer/errors"
import {
  beginBuildOperationReceipt,
  beginBuildOperationReceiptInTransaction,
  completeBuildOperationReceipt,
  failBuildOperationReceipt,
} from "@/src/server/build/receipts"
import { scopedTracerTransaction } from "@/src/server/tracer/db"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import { withWorkspace } from "@/src/server/auth/context"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"

const resources: Array<{
  database: ReturnType<typeof createTracerDatabase>
  target: IsolatedPostgres
}> = []

const previousBuildEnabled = process.env.DATOOL_BUILD_ENABLED
beforeEach(() => {
  process.env.DATOOL_BUILD_ENABLED = "true"
})

afterEach(async () => {
  if (previousBuildEnabled === undefined) delete process.env.DATOOL_BUILD_ENABLED
  else process.env.DATOOL_BUILD_ENABLED = previousBuildEnabled
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeContext() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  return {
    database,
    projectId: target.projectId,
    actorId: target.ownerId,
  }
}

describe("Build operation receipts", () => {
  test("replays completed results, rejects changed input, and retries failures", async () => {
    const context = await makeContext()
    const first = await beginBuildOperationReceipt(
      context,
      "build_create_agent",
      "request-1",
      { name: "Support", configuration: { locale: "en" } }
    )
    expect(first.kind).toBe("execute")
    if (first.kind !== "execute") return
    await completeBuildOperationReceipt(context, first.id, {
      id: "agent-1",
      status: "active",
    })

    const replay = await beginBuildOperationReceipt(
      context,
      "build_create_agent",
      "request-1",
      { configuration: { locale: "en" }, name: "Support" }
    )
    expect(replay).toEqual({
      kind: "replay",
      result: { id: "agent-1", status: "active" },
    })

    await assert.rejects(
      beginBuildOperationReceipt(context, "build_create_agent", "request-1", {
        name: "Different",
      }),
      (error: unknown) => {
        expect(error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "IDEMPOTENCY_KEY_REUSED" },
        })
        return true
      }
    )

    const failed = await beginBuildOperationReceipt(
      context,
      "build_update_agent",
      "request-2",
      { agentId: "agent-1", expectedRevision: 1 }
    )
    expect(failed.kind).toBe("execute")
    if (failed.kind !== "execute") return
    await failBuildOperationReceipt(
      context,
      failed.id,
      new TracerError("CONFLICT", "Revision changed.")
    )
    const retry = await beginBuildOperationReceipt(
      context,
      "build_update_agent",
      "request-2",
      { expectedRevision: 1, agentId: "agent-1" }
    )
    expect(retry.kind).toBe("execute")
    if (retry.kind === "execute") expect(retry.id).toBe(failed.id)
  }, 30_000)

  test("serializes concurrent reservations for one key", async () => {
    const context = await makeContext()
    const input = { name: "Support" }
    const results = await Promise.allSettled([
      beginBuildOperationReceipt(
        context,
        "build_create_agent",
        "request-3",
        input
      ),
      beginBuildOperationReceipt(
        context,
        "build_create_agent",
        "request-3",
        input
      ),
    ])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    const rejected = results.find((result) => result.status === "rejected")
    expect(rejected?.status).toBe("rejected")
    if (rejected?.status === "rejected")
      expect(rejected.reason).toMatchObject({
        code: "CONFLICT",
        details: { reason: "IDEMPOTENCY_REQUEST_IN_PROGRESS" },
      })
  }, 30_000)

  test("recovers an abandoned pending receipt only after its lease expires", async () => {
    const context = await makeContext()
    const pending = await beginBuildOperationReceipt(
      context,
      "build_create_agent",
      "abandoned-request",
      { name: "Support" }
    )
    expect(pending.kind).toBe("execute")
    if (pending.kind !== "execute") return

    await assert.rejects(
      beginBuildOperationReceipt(
        context,
        "build_create_agent",
        "abandoned-request",
        { name: "Support" }
      ),
      (error: unknown) => {
        expect(error).toMatchObject({
          code: "CONFLICT",
          details: { reason: "IDEMPOTENCY_REQUEST_IN_PROGRESS" },
        })
        return true
      }
    )
    await context.database.execute(sql`
      UPDATE build_operation_receipts
      SET lease_expires_at = now() - interval '1 second'
      WHERE id = ${pending.id} AND project_id = ${context.projectId}
    `)
    const recovered = await beginBuildOperationReceipt(
      context,
      "build_create_agent",
      "abandoned-request",
      { name: "Support" }
    )
    expect(recovered).toEqual({ kind: "execute", id: pending.id })
    if (recovered.kind === "execute")
      await completeBuildOperationReceipt(context, recovered.id, {
        id: "agent-2",
      })
  }, 30_000)

  test("rolls back a mutation and receipt together when completion is interrupted", async () => {
    const context = await makeContext()
    await assert.rejects(
      context.database.transaction(async (tx) => {
        const database = scopedTracerTransaction(context.database, tx)
        const transactionContext = { ...context, database }
        const receipt = await beginBuildOperationReceiptInTransaction(
          transactionContext,
          "build_create_contact",
          "atomic-request",
          { externalId: "atomic-contact" }
        )
        if (receipt.kind !== "execute")
          throw new Error("expected a new receipt")
        await tx.execute(sql`
          INSERT INTO build_contacts (id, project_id, external_id, display_name)
          VALUES ('atomic-contact', ${context.projectId}, 'atomic-contact', 'Atomic')
        `)
        await completeBuildOperationReceipt(transactionContext, receipt.id, {
          id: "atomic-contact",
        })
        throw new Error("response interrupted")
      }),
      /response interrupted/
    )
    const mutation = await context.database.execute(sql`
      SELECT count(*)::text AS count
      FROM build_contacts
      WHERE project_id = ${context.projectId} AND id = 'atomic-contact'
    `)
    expect(mutation.rows[0]?.count).toBe("0")
    const retry = await beginBuildOperationReceipt(
      context,
      "build_create_contact",
      "atomic-request",
      { externalId: "atomic-contact" }
    )
    expect(retry.kind).toBe("execute")
  }, 30_000)

  test("replays through the shared Build operation transport and aliases requestKey", async () => {
    const context = await makeContext()
    const registry = globalThis as typeof globalThis & {
      __datoolBuildDatabases?: Map<string, typeof context.database>
    }
    registry.__datoolBuildDatabases ??= new Map()
    registry.__datoolBuildDatabases.set(context.projectId, context.database)
    try {
      const first = await withWorkspace(
        {
          organizationId: "organization",
          projectId: context.projectId,
          userId: context.actorId,
          kind: "oauth",
          scopes: ["build:write"],
        },
        () =>
          executeBuildOperation("build_create_agent", {
            id: "receipt-agent",
            name: "Receipt agent",
            requestKey: "transport-request-1",
          })
      )
      const replay = await withWorkspace(
        {
          organizationId: "organization",
          projectId: context.projectId,
          userId: context.actorId,
          kind: "oauth",
          scopes: ["build:write"],
        },
        () =>
          executeBuildOperation(
            "build_create_agent",
            { id: "receipt-agent", name: "Receipt agent" },
            { idempotencyKey: "transport-request-1" }
          )
      )
      expect(replay).toEqual(first)
      const rows = await context.database.execute<{ count: string }>(sql`
        SELECT count(*)::text AS count
        FROM build_agents
        WHERE project_id = ${context.projectId} AND id = 'receipt-agent'
      `)
      expect(rows.rows[0]?.count).toBe("1")
    } finally {
      registry.__datoolBuildDatabases.delete(context.projectId)
    }
  }, 30_000)

  test("redacts historical action headers when a save receipt is replayed", async () => {
    const context = await makeContext()
    const input = {
      agentId: "legacy-agent",
      id: "legacy-action",
      slug: "legacy-action",
      definition: {
        id: "legacy-action",
        type: "http",
        name: "Legacy action",
        method: "GET",
        url: "https://example.test/legacy",
        headers: {
          "X-Auth": "legacy-auth-secret",
          "X-Workspace": "legacy-workspace",
        },
      },
    }
    const result = {
      id: "legacy-action",
      projectId: context.projectId,
      agentId: "legacy-agent",
      slug: "legacy-action",
      revision: 1,
      definition: input.definition,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }
    const idempotencyKey = "legacy-action-receipt-replay"
    const inputHash = createHash("sha256")
      .update(canonicalJson(input))
      .digest("hex")
    await context.database.execute(sql`
      INSERT INTO build_operation_receipts
        (id, project_id, operation_name, idempotency_key, input_hash,
         status, result_json, actor_id, completed_at)
      VALUES
        ('legacy-action-receipt', ${context.projectId}, 'build_save_action',
         ${idempotencyKey}, ${inputHash}, 'completed',
         ${JSON.stringify(result)}::jsonb, ${context.actorId}, now())
    `)

    const registry = globalThis as typeof globalThis & {
      __datoolBuildDatabases?: Map<string, typeof context.database>
    }
    registry.__datoolBuildDatabases ??= new Map()
    registry.__datoolBuildDatabases.set(context.projectId, context.database)
    try {
      const replay = await withWorkspace(
        {
          organizationId: "organization",
          projectId: context.projectId,
          userId: context.actorId,
          kind: "oauth",
          scopes: ["build:write"],
        },
        () =>
          executeBuildOperation("build_save_action", input, {
            idempotencyKey,
          })
      )
      const definition = (
        replay as { definition: { headers: Record<string, string> } }
      ).definition
      expect(definition.headers["X-Auth"]).toBe("[redacted]")
      expect(definition.headers["X-Workspace"]).toBe("[redacted]")
      expect(JSON.stringify(replay)).not.toContain("legacy-auth-secret")
      expect(JSON.stringify(replay)).not.toContain("legacy-workspace")
    } finally {
      registry.__datoolBuildDatabases.delete(context.projectId)
    }
  }, 30_000)

  test("rolls back a domain write when response storage fails", async () => {
    const context = await makeContext()
    let attempts = 0
    registerBuildOperation({
      name: "build_test_receipt_atomic_failure",
      description: "Test atomic Build receipt rollback.",
      scopes: ["build:write"],
      schema: z.object({ id: z.string().trim().min(1) }),
      idempotency: "required",
      execute: async (operationContext, input) => {
        await operationContext.database.execute(sql`
          INSERT INTO build_contacts (id, project_id, external_id, display_name)
          VALUES (${input.id}, ${operationContext.projectId}, ${input.id}, 'Atomic')
        `)
        attempts += 1
        // The first response cannot be persisted. The enclosing transaction
        // must roll back both this contact and its pending receipt.
        return attempts === 1
          ? { id: input.id, response: BigInt(1) }
          : { id: input.id }
      },
    })
    const registry = globalThis as typeof globalThis & {
      __datoolBuildDatabases?: Map<string, typeof context.database>
    }
    registry.__datoolBuildDatabases ??= new Map()
    registry.__datoolBuildDatabases.set(context.projectId, context.database)
    const identity = {
      organizationId: "organization",
      projectId: context.projectId,
      userId: context.actorId,
      kind: "oauth" as const,
      scopes: ["build:write"],
    }
    try {
      await assert.rejects(
        withWorkspace(identity, () =>
          executeBuildOperation("build_test_receipt_atomic_failure", {
            id: "atomic-retry",
            idempotencyKey: "atomic-retry-key",
          })
        ),
        (error: unknown) => {
          expect(error).toMatchObject({ code: "INTERNAL_ERROR" })
          return true
        }
      )
      const afterFailure = await context.database.execute(sql`
        SELECT count(*)::text AS count
        FROM build_contacts
        WHERE project_id = ${context.projectId} AND id = 'atomic-retry'
      `)
      expect(afterFailure.rows[0]?.count).toBe("0")

      const result = await withWorkspace(identity, () =>
        executeBuildOperation(
          "build_test_receipt_atomic_failure",
          { id: "atomic-retry" },
          { idempotencyKey: "atomic-retry-key" }
        )
      )
      expect(result).toEqual({ id: "atomic-retry" })
      const replay = await withWorkspace(identity, () =>
        executeBuildOperation(
          "build_test_receipt_atomic_failure",
          { id: "atomic-retry" },
          { idempotencyKey: "atomic-retry-key" }
        )
      )
      expect(replay).toEqual(result)
      const afterRetry = await context.database.execute(sql`
        SELECT count(*)::text AS count
        FROM build_contacts
        WHERE project_id = ${context.projectId} AND id = 'atomic-retry'
      `)
      expect(afterRetry.rows[0]?.count).toBe("1")
    } finally {
      registry.__datoolBuildDatabases.delete(context.projectId)
    }
  }, 30_000)
})
