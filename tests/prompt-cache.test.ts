import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { once } from "node:events"
import { Effect } from "effect"
import { Redis } from "ioredis"
import { defaultPrompt, type ManagedPrompt } from "@/src/lib/tracer/prompts"
import { createPromptCache } from "@/src/server/tracer/prompt-cache"
import { createPromptService } from "@/src/server/tracer/prompts"
import {
  closeTracerDatabase,
  getTracerProjectId,
  registerTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"

async function connect() {
  const value = process.env.DATOOL_TEST_REDIS_URL
  if (
    !value ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)
  )
    throw new Error(
      "DATOOL_TEST_REDIS_URL must point to disposable loopback Redis"
    )
  const redis = new Redis(value, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
  })
  redis.on("error", () => {})
  await redis.connect()
  return redis
}

function countSelects(database: TracerDatabase) {
  const original = database.select
  let count = 0
  database.select = ((...args: Parameters<typeof original>) => {
    count++
    return original.apply(database, args)
  }) as typeof original
  return {
    count: () => count,
    reset: () => {
      count = 0
    },
    restore: () => {
      database.select = original
    },
  }
}

const config = {
  ...defaultPrompt,
  name: "Support",
  slug: "support",
  model: "openai/gpt-4.1-mini",
  messages: [{ role: "system" as const, content: "Help {{customer}}." }],
  metadata: { owner: "support", nested: { enabled: true } },
  temperature: 0.3,
  maxTokens: 500,
}
const fixture: ManagedPrompt = {
  ...config,
  id: "prompt-example",
  revision: 2,
  version: 1,
  publishedVersion: 1,
  publishedAt: new Date().toISOString(),
  hasDraft: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}
const lookup = { id: "support", bySlug: true }

test("published prompt cache shares full responses across workers without SQL and invalidates all reads after writes", async () => {
  const redisA = await connect(),
    redisB = await connect()
  const database = await createTracerFixture()
  const reopened = reopenTracerFixture(database)
  const selectA = countSelects(database),
    selectB = countSelects(reopened)
  const run = Effect.runPromise
  try {
    const a = createPromptService(database, createPromptCache(redisA))
    const b = createPromptService(reopened, createPromptCache(redisB))
    const saved = await run(a.save(config))
    await rejects(run(b.get("support", true)), /not found/)
    const published = await run(
      a.publish(saved.id, { expectedRevision: saved.revision })
    )
    selectA.reset()
    const first = await run(a.get("support", true))
    expect(first).toMatchObject({ ...config, version: 1 })
    expect(selectA.count()).toBe(1)
    selectA.reset()
    selectB.reset()
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => run(b.get("support", true)))
    )
    expect(
      responses.every(
        (value) => JSON.stringify(value) === JSON.stringify(first)
      )
    ).toBe(true)
    expect(selectA.count()).toBe(0)
    expect(selectB.count()).toBe(0)
    // Project boundaries are part of the key even when the slug is identical.
    registerTracerProjectId(reopened, crypto.randomUUID())
    await rejects(
      run(
        createPromptService(reopened, createPromptCache(redisB)).get(
          "support",
          true
        )
      ),
      /not found/
    )
    registerTracerProjectId(reopened, getTracerProjectId(database))
    await run(a.get(saved.id, false, 1))
    expect(selectA.count()).toBe(2)
    selectB.reset()
    expect(await run(b.get(saved.id, false, 1))).toEqual(first)
    expect(selectB.count()).toBe(0)
    const draft = await run(
      a.save(
        {
          ...config,
          model: "openai/gpt-4.1",
          metadata: { owner: "new" },
          expectedRevision: published.revision,
        },
        saved.id
      )
    )
    expect(await run(b.get("support", true))).toMatchObject({
      ...config,
      hasDraft: true,
      revision: draft.revision,
    })
    expect((await run(b.get(saved.id, false, 1))).hasDraft).toBe(true)
    selectB.reset()
    expect((await run(b.get(saved.id))).model).toBe("openai/gpt-4.1")
    await run(b.get(saved.id))
    expect(selectB.count()).toBe(2) // Management drafts never use cache.
    const second = await run(
      a.publish(saved.id, { expectedRevision: draft.revision })
    )
    expect(await run(b.get("support", true))).toMatchObject({
      model: "openai/gpt-4.1",
      metadata: { owner: "new" },
      version: 2,
      hasDraft: false,
    })
    expect(await run(b.get(saved.id, false, 1))).toMatchObject({
      ...config,
      version: 1,
      publishedVersion: 2,
      hasDraft: false,
    })
    await run(a.remove(saved.id, second.revision))
    for (const read of [
      b.get("support", true),
      b.get(saved.id, false, 1),
      b.get("support", true, 2),
    ])
      await rejects(run(read), /not found/)
    await rejects(run(b.get("support", true, NaN)), /positive integer/)
  } finally {
    selectA.restore()
    selectB.restore()
    await closeTracerDatabase(reopened)
    await closeTracerFixture(database)
    await Promise.all([redisA.quit(), redisB.quit()])
  }
}, 30_000)

test("concurrent misses coalesce and an old in-flight read cannot refill an invalidated cache", async () => {
  const redis = await connect()
  try {
    const cache = createPromptCache(redis),
      otherWorker = createPromptCache(redis)
    const project = crypto.randomUUID()
    let loads = 0
    const burst = await Promise.all(
      Array.from({ length: 50 }, () =>
        cache.get(project, lookup, async () => {
          loads++
          await new Promise((resolve) => setTimeout(resolve, 20))
          return fixture
        })
      )
    )
    expect(loads).toBe(1)
    burst[0].metadata.owner = "mutated by caller"
    expect(burst[1].metadata.owner).toBe("support")
    await cache.invalidate(project)
    let release!: (value: ManagedPrompt) => void
    let entered!: () => void
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const oldRead = cache.get(project, lookup, () => {
      entered()
      return new Promise((resolve) => {
        release = resolve
      })
    })
    await started
    await otherWorker.invalidate(project)
    const next = { ...fixture, model: "openai/gpt-4.1", version: 2 }
    expect(await otherWorker.get(project, lookup, async () => next)).toEqual(
      next
    )
    release(fixture)
    await oldRead
    expect(
      await cache.get(project, lookup, async () => {
        throw new Error("Unexpected SQL read")
      })
    ).toEqual(next)
  } finally {
    await redis.quit()
  }
})

test("expiry, Redis failure and missing prompts fall back without retaining errors or extending old data", async () => {
  const redis = await connect()
  let now = Date.now(),
    loads = 0
  const project = crypto.randomUUID()
  const cache = createPromptCache(redis, () => now)
  const load = async () => {
    loads++
    return fixture
  }
  try {
    await rejects(
      cache.get(project, lookup, async () => {
        throw new Error("Not published")
      }),
      /Not published/
    )
    await cache.get(project, lookup, load)
    await cache.get(project, lookup, load)
    expect(loads).toBe(1)
    now += 60_000
    await cache.get(project, lookup, load)
    expect(loads).toBe(2)
    const originalEval = redis.eval
    redis.eval = (() =>
      Promise.reject(new Error("Redis command failed"))) as typeof redis.eval
    await cache.get(project, lookup, load)
    expect(loads).toBe(3)
    redis.eval = originalEval
    const ended = once(redis, "end")
    redis.disconnect()
    await ended
    await cache.invalidate(project) // Committed writes must still succeed.
    await cache.get(project, lookup, load)
    expect(loads).toBe(4)
    await redis.connect()
    // Missed invalidations during an outage cannot extend the original TTL.
    now += 60_000
    const current = { ...fixture, version: 2 }
    expect(await cache.get(project, lookup, async () => current)).toEqual(
      current
    )
    // A slow pre-invalidation read cannot outlive the generation safety window.
    const slowProject = crypto.randomUUID()
    await cache.get(slowProject, lookup, async () => {
      now += 60_000
      return fixture
    })
    expect(await cache.get(slowProject, lookup, async () => current)).toEqual(
      current
    )
  } finally {
    redis.disconnect()
  }
})
