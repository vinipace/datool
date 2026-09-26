import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { Pool } from "pg"
import {
  applyFilterSuggestion,
  formatFilterQuery,
  getFilterHighlightRanges,
  getFilterSuggestions,
  parseFilterQuery,
} from "@/components/ui/datool/search-bar/filter-query"
import {
  collectionFilterFields,
  compileCollectionFilter,
} from "@/src/lib/tracer/collection-filters"
import { dashboardFilterScope } from "@/src/lib/tracer/dashboard-queries"
import { fullTextSqlFilter } from "@/src/server/semantic/full-text-filter"
import { createIsolatedPostgres } from "./helpers/postgres"

describe("quoted full-text filters", () => {
  test("matches nested string values and ANDs phrases with field comparisons", () => {
    const row = {
      name: "Support request",
      status: "errored",
      input: { messages: [{ content: 'Find "the invoice" at C:\\billing' }] },
      output: [null, { content: "Payment failed" }],
      attributes: {
        details: { region: "São Paulo" },
        count: 123,
        enabled: true,
      },
      secret: "unregistered",
    }
    for (const query of [
      '"SUPPORT"',
      '"payment failed"',
      '"São Paulo"',
      '"invoice" "payment" status = errored',
      "status = errored 'invoice'",
    ]) {
      expect(compileCollectionFilter("traces", query)(row)).toBe(true)
    }
    expect(
      compileCollectionFilter(
        "traces",
        String.raw`"Find \"the invoice\" at C:\\billing"`
      )(row)
    ).toBe(true)
    for (const query of [
      '"absent"',
      '"invoice" status = completed',
      '"invoice payment"',
      '"unregistered"',
      '"details"',
      '"123"',
      '"true"',
    ]) {
      expect(compileCollectionFilter("traces", query)(row)).toBe(false)
    }
    expect(
      compileCollectionFilter(
        "datasetItems",
        '"invoice"'
      )({ expectedOutput: [{ text: "Invoice paid" }] })
    ).toBe(true)
    expect(
      compileCollectionFilter(
        "scorers",
        '"billing"'
      )({ description: "Check billing" })
    ).toBe(true)
    expect(
      compileCollectionFilter("agents", '"release"')({ version: "release-2" })
    ).toBe(true)
    expect(
      compileCollectionFilter("reviews", '"ana"')({ assigneeName: "Ana" })
    ).toBe(true)
  })

  test("preserves quoted paths, source ranges, chips and autocomplete", () => {
    const fields = collectionFilterFields.traces
    const query =
      '"hello world" "status" = completed metadata."ai.model.id" = "gpt"'
    const clauses = parseFilterQuery(query)
    expect(clauses).toHaveLength(3)
    expect(clauses[0]).toEqual({ text: "hello world", start: 0, end: 13 })
    expect(clauses[1]).toMatchObject({
      path: ["status"],
      operator: "=",
      value: "completed",
    })
    expect(clauses[2]).toMatchObject({
      path: ["metadata", "ai.model.id"],
      value: "gpt",
    })
    expect(formatFilterQuery(query, fields)?.map((item) => item.label)).toEqual(
      ['"hello world"', "Status: Completed", 'metadata."ai.model.id": "gpt"']
    )
    expect(getFilterHighlightRanges(query + " name =", fields)).toHaveLength(3)
    const partial = '"hello world" sta'
    const suggestion = getFilterSuggestions(
      partial,
      partial.length,
      fields
    ).find((item) => item.insertText === "status = ")!
    expect(
      applyFilterSuggestion(partial, partial.length, fields, suggestion).value
    ).toBe('"hello world" status = ')
    expect(getFilterSuggestions('"hello', 6, fields)).toEqual([])
    const scope = dashboardFilterScope(
      '"hello world" startedAt >= -3d',
      Date.parse("2026-09-13T00:00:00Z"),
      "UTC"
    )
    expect(scope.filter).toBe('"hello world"')
    expect(scope.from).toBe("2026-09-10T00:00:00.000Z")
  })

  test("rejects empty, incomplete and unseparated phrases without relaxing field validation", () => {
    for (const query of [
      '""',
      '"  "',
      '"unfinished',
      '"a""b"',
      '"a"status = completed',
      '"a" unknown = 1',
      '"a" metadata.__proto__ = 1',
      '"a" '.repeat(51),
    ]) {
      expect(() => compileCollectionFilter("traces", query)).toThrow()
    }
  })
})

test("SQL and local search agree on decoded JSON, literals, nulls and missing values", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  const dialect = new PgDialect()
  const payloads = [
    'Find "invoice" at C:\\billing',
    { nested: [{ text: 'Find "invoice" at C:\\billing' }] },
    ["100%_paid", "São Paulo", "line\nbreak", "x' OR true --"],
    { invoice: null, number: 123, flag: true },
    null,
    [],
  ]
  try {
    for (const input of payloads) {
      for (const needle of [
        "INVOICE",
        '"invoice"',
        "C:\\billing",
        "%_",
        "São",
        "line\nbreak",
        "x' OR true --",
        "missing",
        "123",
        "true",
      ]) {
        const expression = `"${needle.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
        const local = compileCollectionFilter(
          "datasetItems",
          expression
        )({ input })
        for (const nativeJson of [true, false]) {
          const value = nativeJson
            ? sql`${JSON.stringify(input)}::jsonb`
            : sql`${JSON.stringify(input)}::text`
          const query = dialect.sqlToQuery(
            sql`select ${fullTextSqlFilter([{ value, type: "json", nativeJson }], needle)} as matches`
          )
          const result = await pool.query(query.sql, query.params)
          expect(result.rows[0].matches).toBe(local)
        }
      }
    }
    await pool.query("create table search_payload (value text)")
    await pool.query(
      "insert into search_payload values ('invalid json'), (null)"
    )
    const invalid = dialect.sqlToQuery(
      sql`select ${fullTextSqlFilter([{ value: sql`value`, type: "json" }], "invalid")} as matches from search_payload`
    )
    expect((await pool.query(invalid.sql, invalid.params)).rows).toEqual([
      { matches: false },
      { matches: false },
    ])
  } finally {
    await pool.end()
    await target.close()
  }
})
