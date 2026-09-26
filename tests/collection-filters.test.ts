import { describe, expect, test } from "bun:test"
import { preserveFixedFilters } from "@/components/ui/datool/search-bar/filter-draft"
import {
  applyFilterSuggestion,
  getFilterHighlightRanges,
  getFilterSuggestions,
  parseFilterQuery,
  formatFilterQuery,
} from "@/components/ui/datool/search-bar/filter-query"
import {
  collectionFilterFields,
  compileCollectionFilter,
} from "@/src/lib/tracer/collection-filters"
import {
  closeTracerDatabase,
  createTracerDatabase,
} from "@/src/server/tracer/db"
import { evalRuns, sessions, traces } from "@/src/server/tracer/schema"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "@/tests/helpers/postgres"

const example = `metadata."ai.model.id" = 'gpt-4o-mini' output.role = 'assistant' metrics.time_to_first_token < 3`

describe("collection filter language", () => {
  test("fixed filters preserve the selected range while clearing or replacing other clauses", () => {
    const fixedFilters = [{ field: "startedAt", defaultExpression: "startedAt >= -3d" }]
    const range = 'startedAt >= "2026-09-01" startedAt <= "2026-09-13"'
    expect(preserveFixedFilters('"invoice"', "", fixedFilters)).toBe('startedAt >= -3d "invoice"')
    expect(preserveFixedFilters("", `${range} status = errored`, fixedFilters)).toBe(range)
    expect(preserveFixedFilters('"startedAt"', range, fixedFilters)).toBe(`${range} "startedAt"`)
    expect(preserveFixedFilters("startedAt >= -7d", range, fixedFilters)).toBe("startedAt >= -7d")
    expect(preserveFixedFilters("status =", range, fixedFilters)).toBe("status =")
  })

  test("scorer filters combine type, text, revision and dates on the full catalog", () => {
    const rows = [
      { name: "Invoice quality", slug: "invoice-quality", description: "Review billing answers", type: "llm", revision: 3, updatedAt: "2026-09-10T00:00:00Z" },
      { name: "Invoice syntax", slug: "invoice-syntax", description: "Check JSON", type: "javascript", revision: 1, updatedAt: "2026-09-01T00:00:00Z" },
      { name: "Support style", slug: "support-style", description: "Review tone", type: "llm", revision: 1, updatedAt: "2026-09-10T00:00:00Z" },
    ]
    const match = compileCollectionFilter("scorers", 'type = "llm" name : "INVOICE" revision >= 2 updatedAt >= "2026-09-05T00:00:00Z"')
    expect(rows.filter(match).map((row) => row.slug)).toEqual(["invoice-quality"])
    expect(rows.filter(compileCollectionFilter("scorers", 'description : "json"')).map((row) => row.slug)).toEqual(["invoice-syntax"])
    expect(rows.filter(compileCollectionFilter("scorers", ""))).toEqual(rows)
  })

  test("scorer field suggestions and validation use the shared filter contract", () => {
    const fields = collectionFilterFields.scorers
    expect(getFilterSuggestions("type = ", 7, fields).map((item) => item.label)).toEqual(["llm", "javascript", "python", "library"])
    expect(compileCollectionFilter("scorers", 'type = "python"')({ type: "python" })).toBe(true)
    for (const query of ['type = "ruby"', 'revision = "two"', 'code : "secret"', "name =", "updatedAt >= nonsense"]) {
      expect(() => compileCollectionFilter("scorers", query)).toThrow()
    }
  })

  test("replacing a quoted suggestion consumes the whole previous value", () => {
    const value = "startedAt >= -3d status = 'errored'"
    const suggestion = getFilterSuggestions(
      value,
      value.length,
      collectionFilterFields.traces
    ).find((item) => item.label === "errored")!
    expect(
      applyFilterSuggestion(
        value,
        value.length,
        collectionFilterFields.traces,
        suggestion
      ).value
    ).toBe('startedAt >= -3d status = "errored" ')
  })

  test("formats blurred filters without changing their meaning or source", () => {
    const value = "startedAt >= -3d status = 'completed'"
    const formatted = formatFilterQuery(value, collectionFilterFields.traces)!
    expect(formatted.map((item) => item.label)).toEqual([
      "Past 3 days",
      "Status: Completed",
    ])
    expect(formatted.map((item) => item.raw)).toEqual([
      "startedAt >= -3d",
      "status = 'completed'",
    ])
    expect(
      formatFilterQuery("startedAt >= -1h", collectionFilterFields.traces)![0]
        .label
    ).toBe("Past 1 hour")
    expect(
      formatFilterQuery("startedAt < -3d", collectionFilterFields.traces)![0]
        .label
    ).toBe('Started at < "-3d"')
    expect(
      formatFilterQuery(
        'metadata."ai.model.id" = "gpt-4o-mini"',
        collectionFilterFields.traces
      )![0].label
    ).toBe('metadata."ai.model.id": "gpt-4o-mini"')
    expect(formatFilterQuery("", collectionFilterFields.traces)).toBe(null)
    expect(
      formatFilterQuery("startedAt >=", collectionFilterFields.traces)
    ).toBe(null)
    expect(
      formatFilterQuery("unknown = 1", collectionFilterFields.traces)
    ).toBe(null)
    const operationQuery = 'groupName = "Customer answers" groupType = workflow groupVersion = "v2"'
    const operations = formatFilterQuery(operationQuery, collectionFilterFields.evalQuality)!
    expect(operations.map((item) => item.label)).toEqual([
      'Operation name: "Customer answers"',
      "Operation type: Workflow",
      'Operation version: "v2"',
    ])
    expect(operations.map((item) => item.raw).join(" ")).toBe(operationQuery)
    const suggestion = getFilterSuggestions("Operation name", 14, collectionFilterFields.evalQuality)
      .find((item) => item.label === "Operation name = ")!
    expect(suggestion.insertText).toBe("groupName = ")
    expect(applyFilterSuggestion("Operation name", 14, collectionFilterFields.evalQuality, suggestion).value)
      .toBe("groupName = ")
    expect(getFilterSuggestions("groupName", 9, collectionFilterFields.evalQuality)
      .find((item) => item.label === "Operation name = "))
      .toEqual(suggestion)
  })

  test("time and status expressions share a fixed backend cutoff", () => {
    const now = Date.parse("2026-09-07T12:00:00Z")
    const match = compileCollectionFilter(
      "traces",
      "startedAt >= -3d status = 'completed'",
      now
    )
    expect(
      match({ startedAt: "2026-09-04T12:00:00Z", status: "completed" })
    ).toBe(true)
    expect(
      match({ startedAt: "2026-09-04T11:59:59Z", status: "completed" })
    ).toBe(false)
    expect(
      match({ startedAt: "2026-09-07T11:00:00Z", status: "errored" })
    ).toBe(false)
    expect(
      compileCollectionFilter(
        "traces",
        "",
        now
      )({ startedAt: "2020-01-01T00:00:00Z", status: "errored" })
    ).toBe(true)
    for (const value of ["-0d", "-3months", "-9999999999999999w"]) {
      expect(() =>
        compileCollectionFilter("traces", `startedAt >= ${value}`, now)
      ).toThrow()
    }
    const input = "status = 'completed' startedAt >= "
    const suggestion = getFilterSuggestions(
      input,
      input.length,
      collectionFilterFields.traces
    ).find((item) => item.label === "Past 3 days (-3d)")!
    expect(suggestion).toBeDefined()
    expect(
      applyFilterSuggestion(
        input,
        input.length,
        collectionFilterFields.traces,
        suggestion
      ).value
    ).toBe("status = 'completed' startedAt >= -3d ")
  })

  test("user example preserves dotted keys and ANDs typed clauses", () => {
    const matches = compileCollectionFilter("traces", example)
    const row = {
      attributes: {
        "ai.model.id": "gpt-4o-mini",
        metrics: { time_to_first_token: 2.5 },
      },
      output: { role: "assistant" },
    }
    expect(matches(row)).toBe(true)
    expect(matches({ ...row, output: { role: "user" } })).toBe(false)
    expect(
      matches({
        ...row,
        attributes: {
          ...row.attributes,
          metrics: { time_to_first_token: "2.5" },
        },
      })
    ).toBe(false)
    expect(
      matches({
        ...row,
        attributes: { ...row.attributes, metrics: { time_to_first_token: 3 } },
      })
    ).toBe(false)
    expect(
      compileCollectionFilter(
        "traces",
        'metadata.ai.model.id = "gpt-4o-mini"'
      )(row)
    ).toBe(false)
  })

  test("handles strings, escapes, arrays, null, booleans, and numeric bounds", () => {
    expect(
      compileCollectionFilter(
        "traces",
        `name = 'Agent \\'one\\'' input.messages.0.role = "user" metadata.enabled = true durationMs >= 2e2 durationMs <= 200 endedAt = null`
      )({
        name: "Agent 'one'",
        input: { messages: [{ role: "user" }] },
        attributes: { enabled: true },
        durationMs: 200,
        endedAt: null,
      })
    ).toBe(true)
    expect(
      compileCollectionFilter(
        "sessions",
        `name : 'HELLO' traceCount != 0`
      )({ name: "Say hello world", traceCount: 1 })
    ).toBe(true)
    expect(
      compileCollectionFilter(
        "sessions",
        "metadata.missing != null"
      )({ attributes: {} })
    ).toBe(false)
    expect(
      compileCollectionFilter(
        "traces",
        `startedAt >= '2026-09-01T00:00:00Z'`
      )({ startedAt: "2026-09-02T00:00:00.000Z" })
    ).toBe(true)
  })

  test("allows substring matching on enum fields", () => {
    expect(
      compileCollectionFilter(
        "traces",
        "status : 'comp'"
      )({ status: "completed" })
    ).toBe(true)
    expect(
      compileCollectionFilter(
        "traces",
        "status : 'comp'"
      )({ status: "errored" })
    ).toBe(false)
  })

  test("rejects incomplete, unsafe, unsupported and oversized expressions", () => {
    for (const query of [
      "name =",
      "name == 'x'",
      "name = 'unclosed",
      "durationMs > nope",
      "wat = 1",
      "metadata.__proto__.x = 1",
      'metadata."constructor" = 1',
      "name > 1",
      "status = invented",
      "startedAt > 'nonsense'",
      "name = 'a' OR name = 'b'",
      "name = 'a'name = 'b'",
      "name = " + "x".repeat(4000),
    ]) {
      expect(() => compileCollectionFilter("traces", query)).toThrow()
    }
  })

  test("autocomplete replaces the active clause and preserves surrounding comparisons", () => {
    const fields = collectionFilterFields.traces
    const query = "name = 'hello world' sta"
    const suggestion = getFilterSuggestions(query, query.length, fields).find(
      (item) => item.insertText === "status = "
    )!
    expect(suggestion).toBeDefined()
    const next = applyFilterSuggestion(query, query.length, fields, suggestion)
    expect(next.value).toBe("name = 'hello world' status = ")
    const values = getFilterSuggestions(next.value, next.value.length, fields)
    expect(values.map((item) => item.label)).toContain("completed")
    const completed = applyFilterSuggestion(
      next.value,
      next.value.length,
      fields,
      values.find((item) => item.label === "completed")!
    )
    expect(parseFilterQuery(completed.value)).toHaveLength(2)
    const middle = `status = 'run' name = 'keep'`
    const choice = getFilterSuggestions(middle, 12, fields).find(
      (item) => item.label === "running"
    )!
    expect(applyFilterSuggestion(middle, 12, fields, choice).value).toContain(
      "name = 'keep'"
    )
    expect(
      getFilterHighlightRanges(example + " durationMs >", fields)
    ).toHaveLength(3)
  })
})

describe("server-filtered collections", () => {
  test("filters full collections before cursors and totals across all three resources", async () => {
    const target = await createIsolatedPostgres()
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const database = createTracerDatabase(target.databaseUrl, {
      projectId: target.projectId,
      schema: target.schema,
    })
    const service = new TracerService(database)
    const timestamp = "2026-09-07T00:00:00.000Z"
    try {
      await database.insert(sessions).values(
        Array.from({ length: 65 }, (_, index) => ({
          id: `session-${String(index).padStart(2, "0")}`,
          projectId: target.projectId,
          name: index < 3 ? "Target" : "Other",
          attributesJson: JSON.stringify({
            cohort: index < 3 ? "target" : "other",
          }),
          createdAt: timestamp,
          updatedAt: timestamp,
        }))
      )
      await database.insert(traces).values(
        Array.from({ length: 65 }, (_, index) => ({
          id: `trace-${String(index).padStart(2, "0")}`,
          projectId: target.projectId,
          sessionId: `session-${String(index).padStart(2, "0")}`,
          name: "Trace",
          operation: "test",
          status: "completed",
          startedAt: timestamp,
          attributesJson: JSON.stringify({
            "ai.model.id": index < 3 ? "gpt-4o-mini" : "other",
            metrics: { time_to_first_token: 2 },
          }),
          outputJson: JSON.stringify({ role: "assistant" }),
        }))
      )
      await database.insert(evalRuns).values(
        Array.from({ length: 65 }, (_, index) => ({
          id: `eval-${String(index).padStart(2, "0")}`,
          projectId: target.projectId,
          name: "Eval",
          status: "completed",
          createdAt: timestamp,
          metadataJson: JSON.stringify({
            cohort: index < 3 ? "target" : "other",
          }),
        }))
      )
      for (const [list, filter] of [
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listTraces({ ...options, includeTotal: true }),
          example,
        ],
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listSessions({ ...options, includeTotal: true }),
          "metadata.cohort = 'target' traceCount = 1",
        ],
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listEvalRuns({ ...options, includeTotal: true }),
          "metadata.cohort = 'target' resultCount = 0",
        ],
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listTraces({ ...options, includeTotal: true }),
          '"GPT-4O-MINI" "assistant" status = completed',
        ],
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listSessions({ ...options, includeTotal: true }),
          '"TARGET" traceCount = 1',
        ],
        [
          (options: { filter: string; limit: number; cursor?: string }) =>
            service.listEvalRuns({ ...options, includeTotal: true }),
          '"TARGET" resultCount = 0',
        ],
      ] as const) {
        // The matches are older than the first unfiltered page of 50.
        const first = await runTracerEffect<{
          items: { id: string }[]
          nextCursor: string | null
          total?: number
        }>(list({ filter, limit: 2 }))
        expect(first.total).toBe(3)
        expect(first.items).toHaveLength(2)
        expect(first.nextCursor).toBeTruthy()
        const second = await runTracerEffect<{
          items: { id: string }[]
          nextCursor: string | null
          total?: number
        }>(list({ filter, limit: 2, cursor: first.nextCursor! }))
        expect(second.total).toBe(3)
        expect(second.items).toHaveLength(1)
        expect(second.nextCursor).toBeNull()
        expect(second.items[0].id).not.toBe(first.items[0].id)
        const cleared = await runTracerEffect<{
          items: { id: string }[]
          nextCursor: string | null
          total?: number
        }>(list({ filter: "", limit: 50 }))
        expect(cleared.total).toBe(65)
        const error = await runTracerEffect<{
          items: { id: string }[]
          nextCursor: string | null
          total?: number
        }>(list({ filter: "invalid = 1", limit: 2 })).then(
          () => null,
          (error: unknown) => error
        )
        expect(error).toMatchObject({ code: "VALIDATION_ERROR", status: 400 })
      }
      const scoped = await runTracerEffect(
        service.listTraces({
          includeTotal: true,
          filter: example,
          sessionId: "session-00",
        })
      )
      expect(scoped.total).toBe(1)
      expect(scoped.items[0].spanStats).toBeDefined()
      expect(
        (
          await runTracerEffect(
            service.listTraces({
              includeTotal: true,
              filter: "name = 'no match'",
            })
          )
        ).total
      ).toBe(0)
    } finally {
      await closeTracerDatabase(database)
      await target.close()
    }
  })
})
