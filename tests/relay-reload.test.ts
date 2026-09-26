import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import { createPlaygroundStorage } from "../src/server/playground/storage"
import { withWorkspace } from "../src/server/auth/context"
import { createRelay } from "../src/server/apps/relay"
import { createAppCatalog } from "../src/server/apps/catalog"

const definition = {
  id: "echo",
  name: "Echo",
  mode: "input",
  inputSchema: { type: "object" },
  outputSchema: {},
}
async function fixture(
  run: (f: {
    pool: Pool
    storage: ReturnType<typeof createPlaygroundStorage>
    relay: ReturnType<typeof createRelay>
    catalog: ReturnType<typeof createAppCatalog>
    session: {
      id: string
      token: string
      appIds: string[]
      revisions: Record<string, number>
      transport: "relay"
      protocolVersion?: 2
    }
  }) => Promise<void>,
  protocolVersion?: 2
) {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    await withWorkspace(
      {
        organizationId: target.organizationId,
        projectId: target.projectId,
        kind: "api-key",
        scopes: ["apps:read", "apps:write"],
      },
      async () => {
        const storage = createPlaygroundStorage(pool)
        const relay = createRelay(pool, storage)
        const catalog = createAppCatalog(storage)
        await catalog.registerApps([definition])
        const session = {
          id: randomUUID(),
          token: randomUUID(),
          appIds: ["echo"],
          revisions: { echo: 1 },
          transport: "relay" as const,
          protocolVersion,
        }
        await relay.register(session)
        await run({ pool, storage, relay, catalog, session })
      }
    )
  } finally {
    await pool.end()
    await target.close()
  }
}
const poll = (session: { id: string; token: string }) => ({
  id: session.id,
  token: session.token,
  requestId: randomUUID(),
  capacity: 1,
  results: [],
})
const result = { ok: true as const, output: "done", telemetryComplete: true }
async function queued(pool: Pool, count: number) {
  for (let i = 0; i < 200; i++) {
    if (
      (await pool.query("SELECT count(*)::int AS count FROM app_bridge_job"))
        .rows[0].count === count
    )
      return
    await delay(10)
  }
  throw new Error("Job was not enqueued")
}

test(
  "protocol 2 handoff waits for durable late results after a claimed call expires",
  () =>
    fixture(async ({ pool, relay, session }) => {
      const pending = rejects(
        relay.invoke(session.id, "echo", {}, randomUUID()),
        /timed out/
      )
      await queued(pool, 1)
      const claimed = await relay.exchange(poll(session))
      const job = claimed.jobs[0]
      await pool.query(
        "UPDATE app_bridge_job SET deadline=now()-interval '1 second' WHERE id=$1",
        [job.id]
      )
      await pending
      const next = {
        ...session,
        token: randomUUID(),
        resumeToken: session.token,
      }
      await rejects(relay.register(next), /acknowledge claimed/)
      expect(
        (
          await relay.exchange({
            ...poll(session),
            capacity: 0,
            results: [{ id: job.id, result }],
          })
        ).acknowledged
      ).toEqual([job.id])
      await relay.register(next)
      expect(
        (
          await pool.query("SELECT result FROM app_bridge_job WHERE id=$1", [
            job.id,
          ])
        ).rows[0].result
      ).toEqual(result)
      expect((await relay.exchange(poll(next))).jobs).toEqual([])
    }, 2),
  10000
)

for (const protocolVersion of [undefined, 2] as const) {
  test(
    `resume fences old requests, preserves queued deadlines and idempotency, and never transfers uncertain claims (protocol ${protocolVersion ?? 1})`,
    () =>
      fixture(async ({ pool, relay, session }) => {
        const callId = randomUUID()
        const active = relay.invoke(
          session.id,
          "echo",
          {},
          callId,
          undefined,
          10000
        )
        await queued(pool, 1)
        const exchange = poll(session)
        const claimed = await relay.exchange(exchange)
        const next = {
          ...session,
          token: randomUUID(),
          resumeToken: session.token,
        }
        await rejects(relay.register(next), /acknowledge claimed/)
        expect((await relay.exchange(exchange)).jobs).toEqual(claimed.jobs)
        const pending = relay.invoke(
          session.id,
          "echo",
          { pending: true },
          randomUUID(),
          undefined,
          10000
        )
        await queued(pool, 2)
        const before = await pool.query(
          "SELECT id,deadline,claim_id FROM app_bridge_job ORDER BY created_at"
        )
        const completed = {
          ...poll(session),
          capacity: 0,
          results: [{ id: claimed.jobs[0].id, result }],
        }
        await relay.exchange(completed)
        await relay.exchange(completed) // lost acknowledgment retry
        expect(await active).toEqual(result)
        await relay.register(next)
        await relay.register(next) // lost registration response retry
        await rejects(relay.exchange(exchange), /Unknown bridge/)
        await rejects(
          relay.register({ ...session, disconnect: true }),
          /Unknown bridge/
        )
        const after = await pool.query(
          "SELECT id,deadline,claim_id FROM app_bridge_job ORDER BY created_at"
        )
        expect(after.rows).toEqual(before.rows)
        await rejects(
          relay.invoke(session.id, "echo", {}, callId),
          /already dispatched/
        )
        const newClaim = await relay.exchange(poll(next))
        expect(newClaim.jobs).toHaveLength(1)
        expect(newClaim.jobs[0].id).not.toBe(claimed.jobs[0].id)
        await relay.exchange({
          ...poll(next),
          results: [{ id: newClaim.jobs[0].id, result }],
        })
        expect(await pending).toEqual(result)
      }, protocolVersion),
    20000
  )

  test(
    `definition changes fail incompatible queued calls and reject stale resolved definitions before execution (protocol ${protocolVersion ?? 1})`,
    () =>
      fixture(async ({ pool, relay, catalog, session }) => {
        const pending = relay.invoke(
          session.id,
          "echo",
          {},
          randomUUID(),
          undefined,
          10000,
          undefined,
          1
        )
        await queued(pool, 1)
        await catalog.registerApps([
          {
            ...definition,
            inputSchema: { type: "object", required: ["newField"] },
          },
        ])
        const next = {
          ...session,
          token: randomUUID(),
          resumeToken: session.token,
          revisions: { echo: 2 },
        }
        await relay.register(next)
        expect(await pending).toMatchObject({
          ok: false,
          error:
            "App definition changed before execution. Submit a new call using the current definition.",
        })
        expect((await relay.exchange(poll(next))).jobs).toEqual([])
        await rejects(
          relay.invoke(
            session.id,
            "echo",
            {},
            randomUUID(),
            undefined,
            1000,
            undefined,
            1
          ),
          /definition changed/
        )
        const stored = await pool.query("SELECT claim_id FROM app_bridge_job")
        expect(stored.rows[0].claim_id).toBeNull()
      }, protocolVersion),
    20000
  )

  test(
    `enqueue and disconnect use the same transaction lock, leaving no orphan jobs (protocol ${protocolVersion ?? 1})`,
    () =>
      fixture(async ({ pool, storage, session }) => {
        const entered = Promise.withResolvers<void>()
        const release = Promise.withResolvers<void>()
        let block = true
        const relay = createRelay(pool, {
          ...storage,
          mutate: (action) =>
            storage.mutate(async (state, client) => {
              if (block) {
                block = false
                entered.resolve()
                await release.promise
              }
              return action(state, client)
            }),
        })
        const pending = relay.invoke(
          session.id,
          "echo",
          {},
          randomUUID(),
          undefined,
          5000
        )
        await entered.promise
        const disconnect = relay.register({ ...session, disconnect: true })
        release.resolve()
        await disconnect
        expect(await pending).toEqual({
          ok: false,
          error: "Local bridge disconnected.",
        })
        await rejects(
          relay.invoke(session.id, "echo", {}, randomUUID()),
          /offline/
        )
        expect(
          (
            await pool.query(
              "SELECT count(*)::int AS count FROM app_bridge_job WHERE result IS NULL"
            )
          ).rows[0].count
        ).toBe(0)
      }, protocolVersion),
    10000
  )
}

test(
  "enqueue overlapping resume keeps its mailbox and expired jobs never restart",
  () =>
    fixture(async ({ pool, storage, relay, session }) => {
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let block = true
      const slow = createRelay(pool, {
        ...storage,
        mutate: (action) =>
          storage.mutate(async (state, client) => {
            if (block) {
              block = false
              entered.resolve()
              await release.promise
            }
            return action(state, client)
          }),
      })
      const pending = slow.invoke(
        session.id,
        "echo",
        {},
        randomUUID(),
        undefined,
        5000
      )
      await entered.promise
      const next = {
        ...session,
        token: randomUUID(),
        resumeToken: session.token,
      }
      const resume = relay.register(next)
      release.resolve()
      await resume
      const claimed = await relay.exchange(poll(next))
      expect(claimed.jobs).toHaveLength(1)
      await relay.exchange({
        ...poll(next),
        results: [{ id: claimed.jobs[0].id, result }],
      })
      expect(await pending).toEqual(result)
      const expired = rejects(
        relay.invoke(session.id, "echo", {}, randomUUID(), undefined, 100),
        /dispatch deadline/
      )
      await queued(pool, 2)
      await expired
      const last = { ...next, token: randomUUID(), resumeToken: next.token }
      await relay.register(last)
      expect((await relay.exchange(poll(last))).jobs).toEqual([])
    }),
  10000
)

test(
  "delayed duplicate empty and completed polls cannot claim later queued calls",
  () =>
    fixture(async ({ pool, relay, session }) => {
      const empty = { ...poll(session), sequence: 1 }
      expect((await relay.exchange(empty)).jobs).toEqual([])
      const pending = relay.invoke(
        session.id,
        "echo",
        {},
        randomUUID(),
        undefined,
        5000
      )
      await queued(pool, 1)
      expect((await relay.exchange(empty)).jobs).toEqual([])
      const claim = { ...poll(session), sequence: 2 }
      const job = (await relay.exchange(claim)).jobs[0]
      await relay.exchange({
        ...poll(session),
        sequence: 3,
        capacity: 0,
        results: [{ id: job.id, result }],
      })
      expect(await pending).toEqual(result)
      const arriving = relay.invoke(
        session.id,
        "echo",
        {},
        randomUUID(),
        undefined,
        5000
      )
      await queued(pool, 2)
      expect((await relay.exchange(claim)).jobs).toEqual([])
      const next = {
        ...session,
        token: randomUUID(),
        resumeToken: session.token,
      }
      await relay.register(next)
      const newJob = (await relay.exchange({ ...poll(next), sequence: 1 }))
        .jobs[0]
      await relay.exchange({
        ...poll(next),
        sequence: 2,
        results: [{ id: newJob.id, result }],
      })
      expect(await arriving).toEqual(result)
    }),
  10000
)
