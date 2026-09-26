import { afterEach, describe, expect, test } from "bun:test"

import type { CreateTraceInput } from "@/src/lib/tracer/contracts"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerService } from "@/src/server/tracer/service"
import { parseCreateTrace } from "@/src/server/tracer/validation"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

type Fixture = { database: TracerDatabase; target: IsolatedPostgres }

const fixtures = new Set<Fixture>()

afterEach(async () => {
  await Promise.all(
    [...fixtures].map(async ({ database, target }) => {
      await closeTracerDatabase(database)
      await target.close()
    })
  )
  fixtures.clear()
})

async function makeService() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  fixtures.add({ database, target })
  return new TracerService(database)
}

function createTrace(service: TracerService, input: CreateTraceInput) {
  return runTracerEffect(service.createTrace(input))
}

describe("trace span stats", () => {
  test("returns consistent list and detail stats for empty, running, zero-duration, and errored spans", async () => {
    const service = await makeService()
    const empty = await createTrace(service, {
      endedAt: "2026-01-01T00:00:01.000Z",
      id: "tr_empty",
      name: "Empty trace",
      operation: "stats.empty",
      startedAt: "2026-01-01T00:00:00.000Z",
      status: "completed",
    })
    const running = await createTrace(service, {
      endedAt: "2026-01-02T00:00:01.000Z",
      id: "tr_running",
      name: "Running LLM",
      operation: "stats.running",
      spans: [
        {
          id: "sp_running_llm",
          kind: "llm",
          name: "Unfinished completion",
          startedAt: "2026-01-02T00:00:00.000Z",
          status: "running",
        },
      ],
      startedAt: "2026-01-02T00:00:00.000Z",
      status: "completed",
    })
    const zero = await createTrace(service, {
      endedAt: "2026-01-03T00:00:01.000Z",
      id: "tr_zero",
      name: "Zero-duration LLM",
      operation: "stats.zero",
      spans: [
        {
          endedAt: "2026-01-03T00:00:00.000Z",
          id: "sp_zero_llm",
          kind: "llm",
          name: "Cached completion",
          startedAt: "2026-01-03T00:00:00.000Z",
          status: "completed",
        },
      ],
      startedAt: "2026-01-03T00:00:00.000Z",
      status: "completed",
    })
    const errored = await createTrace(service, {
      endedAt: "2026-01-04T00:00:01.000Z",
      id: "tr_errored",
      name: "Errored trace",
      operation: "stats.errored",
      spans: [
        {
          endedAt: "2026-01-04T00:00:00.100Z",
          id: "sp_completed_llm",
          kind: "llm",
          name: "Completed completion",
          startedAt: "2026-01-04T00:00:00.000Z",
          status: "completed",
        },
        {
          endedAt: "2026-01-04T00:00:00.150Z",
          id: "sp_errored_llm",
          kind: "llm",
          name: "Errored completion",
          startedAt: "2026-01-04T00:00:00.100Z",
          status: "errored",
        },
        {
          endedAt: "2026-01-04T00:00:00.200Z",
          id: "sp_errored_tool",
          kind: "tool",
          name: "Errored tool",
          startedAt: "2026-01-04T00:00:00.150Z",
          status: "errored",
        },
        {
          endedAt: "2026-01-04T00:00:00.250Z",
          id: "sp_errored_agent",
          kind: "agent",
          group: { type: "agent", name: "Agent" },
          name: "Errored agent",
          startedAt: "2026-01-04T00:00:00.200Z",
          status: "errored",
        },
        {
          id: "sp_unfinished_llm",
          kind: "llm",
          name: "Unfinished completion",
          startedAt: "2026-01-04T00:00:00.250Z",
          status: "running",
        },
      ],
      startedAt: "2026-01-04T00:00:00.000Z",
      status: "errored",
    })
    const fractional = await createTrace(
      service,
      parseCreateTrace({
        endedAt: "2026-01-05T00:00:01.000Z",
        id: "tr_fractional",
        name: "Fractional timestamp LLM",
        operation: "stats.fractional",
        spans: [
          {
            endedAt: "2026-01-05T00:00:00.0019Z",
            id: "sp_fractional_llm",
            kind: "llm",
            name: "Fractional completion",
            startedAt: "2026-01-05T00:00:00.0004Z",
            status: "completed",
          },
        ],
        startedAt: "2026-01-05T00:00:00.000Z",
        status: "completed",
      })
    )

    expect(empty.spanStats).toEqual({
      errorCount: 0,
      llmCalls: 0,
      llmDurationMs: null,
      spanCount: 0,
      toolCalls: 0,
    })
    expect(running.spanStats).toEqual({
      errorCount: 0,
      llmCalls: 1,
      llmDurationMs: null,
      spanCount: 1,
      toolCalls: 0,
    })
    expect(zero.spanStats).toEqual({
      errorCount: 0,
      llmCalls: 1,
      llmDurationMs: 0,
      spanCount: 1,
      toolCalls: 0,
    })
    expect(errored.spanStats).toEqual({
      errorCount: 3,
      llmCalls: 3,
      llmDurationMs: 150,
      spanCount: 5,
      toolCalls: 1,
    })
    expect(fractional.spanStats).toEqual({
      errorCount: 0,
      llmCalls: 1,
      llmDurationMs: 1,
      spanCount: 1,
      toolCalls: 0,
    })

    const listed = await runTracerEffect(
      service.listTraces({ includeTotal: true, limit: 10 })
    )
    const listedById = new Map(listed.items.map((trace) => [trace.id, trace]))
    for (const trace of [empty, running, zero, errored, fractional]) {
      const detail = await runTracerEffect(service.getTrace(trace.id))
      expect(listedById.get(trace.id)?.spanStats).toEqual(detail.spanStats)
    }
  })

  test("keeps span aggregates isolated to the current cursor page", async () => {
    const service = await makeService()
    const oldest = await createTrace(service, {
      endedAt: "2026-02-01T00:00:01.000Z",
      id: "tr_page_oldest",
      name: "Oldest trace",
      operation: "stats.page.oldest",
      spans: [
        {
          endedAt: "2026-02-01T00:00:00.025Z",
          id: "sp_page_oldest_llm",
          kind: "llm",
          name: "Oldest completion",
          startedAt: "2026-02-01T00:00:00.000Z",
          status: "completed",
        },
      ],
      startedAt: "2026-02-01T00:00:00.000Z",
      status: "completed",
    })
    const middle = await createTrace(service, {
      endedAt: "2026-02-02T00:00:01.000Z",
      id: "tr_page_middle",
      name: "Middle trace",
      operation: "stats.page.middle",
      spans: [
        {
          endedAt: "2026-02-02T00:00:00.025Z",
          id: "sp_page_middle_tool",
          kind: "tool",
          name: "Middle tool",
          startedAt: "2026-02-02T00:00:00.000Z",
          status: "errored",
        },
      ],
      startedAt: "2026-02-02T00:00:00.000Z",
      status: "completed",
    })
    const newest = await createTrace(service, {
      endedAt: "2026-02-03T00:00:01.000Z",
      id: "tr_page_newest",
      name: "Newest trace",
      operation: "stats.page.newest",
      spans: [
        {
          endedAt: "2026-02-03T00:00:00.010Z",
          id: "sp_page_newest_llm_a",
          kind: "llm",
          name: "Newest completion A",
          startedAt: "2026-02-03T00:00:00.000Z",
          status: "completed",
        },
        {
          endedAt: "2026-02-03T00:00:00.030Z",
          id: "sp_page_newest_llm_b",
          kind: "llm",
          name: "Newest completion B",
          startedAt: "2026-02-03T00:00:00.010Z",
          status: "completed",
        },
      ],
      startedAt: "2026-02-03T00:00:00.000Z",
      status: "completed",
    })

    const firstPage = await runTracerEffect(
      service.listTraces({ includeTotal: true, limit: 1 })
    )
    expect(firstPage).toMatchObject({
      nextCursor: newest.id,
      total: 3,
    })
    expect(firstPage.items).toHaveLength(1)
    expect(firstPage.items[0]).toMatchObject({
      id: newest.id,
      spanStats: {
        errorCount: 0,
        llmCalls: 2,
        llmDurationMs: 30,
        spanCount: 2,
        toolCalls: 0,
      },
    })

    const secondPage = await runTracerEffect(
      service.listTraces({
        includeTotal: true,
        cursor: firstPage.nextCursor,
        limit: 1,
      })
    )
    expect(secondPage.items).toHaveLength(1)
    expect(secondPage.items[0]).toMatchObject({
      id: middle.id,
      spanStats: {
        errorCount: 1,
        llmCalls: 0,
        llmDurationMs: null,
        spanCount: 1,
        toolCalls: 1,
      },
    })

    const thirdPage = await runTracerEffect(
      service.listTraces({
        includeTotal: true,
        cursor: secondPage.nextCursor,
        limit: 1,
      })
    )
    expect(thirdPage.items).toHaveLength(1)
    expect(thirdPage.items[0]).toMatchObject({
      id: oldest.id,
      spanStats: {
        errorCount: 0,
        llmCalls: 1,
        llmDurationMs: 25,
        spanCount: 1,
        toolCalls: 0,
      },
    })
    expect(thirdPage.nextCursor).toBeNull()
  })
})
