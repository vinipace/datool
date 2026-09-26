import { describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import {
  applyFilterSuggestion,
  getFilterHighlightRanges,
  getFilterSuggestions,
  parseFilterQuery,
} from "@/components/ui/datool/search-bar/filter-query"
import {
  collectionFilterFields,
  compileCollectionFilter,
} from "@/src/lib/tracer/collection-filters"
import { traceExpressionFilters } from "@/src/lib/semantic/trace-filters"
import { collectionSqlFilter } from "@/src/server/tracer/collection-sql"

describe("contains filter syntax", () => {
  test("matches text, enum and nested values while preserving quoted paths and phrases", () => {
    const query =
      '"name" contains "BILL" status contains err metadata."resource.name" contains "weather:api" "invoice"'
    const row = {
      name: "Billing reply",
      status: "errored",
      attributes: { "resource.name": "mock-weather:api" },
      output: { text: "Invoice failed" },
    }
    const matches = compileCollectionFilter("traces", query)
    expect(matches(row)).toBe(true)
    expect(matches({ ...row, status: "completed" })).toBe(false)
    expect(matches({ ...row, attributes: {} })).toBe(false)
    const clauses = parseFilterQuery(query)
    expect(clauses).toHaveLength(4)
    expect(clauses[0]).toMatchObject({
      path: ["name"],
      operator: ":",
      value: "BILL",
    })
    expect(clauses[2]).toMatchObject({
      path: ["metadata", "resource.name"],
      value: "weather:api",
    })
    expect(query.slice(clauses[0].start, clauses[0].end)).toBe(
      '"name" contains "BILL"'
    )
    expect(clauses[3]).toMatchObject({ text: "invoice" })
    expect(
      getFilterHighlightRanges(
        `${query} name contains`,
        collectionFilterFields.traces
      )
    ).toHaveLength(4)
    expect(
      compileCollectionFilter(
        "traces",
        'name contains "contains"'
      )({ name: "contains" })
    ).toBe(true)
    expect(
      compileCollectionFilter(
        "traces",
        'metadata.contains = "value"'
      )({ attributes: { contains: "value" } })
    ).toBe(true)
  })

  test("keeps legacy semantics and sends the same predicates to SQL and semantic queries", () => {
    const dialect = new PgDialect()
    const sqlFields = {
      name: { value: sql`name`, type: "string" as const },
      metadata: { value: sql`attributes`, type: "json" as const },
    }
    for (const [current, legacy] of [
      ['name contains "100%_paid"', 'name : "100%_paid"'],
      [
        'metadata."resource.name" contains "weather"',
        'metadata."resource.name" : "weather"',
      ],
      ["metadata.enabled contains true", "metadata.enabled : true"],
      ["metadata.count contains 3", "metadata.count : 3"],
      ["metadata.optional contains null", "metadata.optional : null"],
    ]) {
      expect(
        dialect.sqlToQuery(collectionSqlFilter("traces", current, sqlFields))
      ).toEqual(
        dialect.sqlToQuery(collectionSqlFilter("traces", legacy, sqlFields))
      )
      expect(traceExpressionFilters(current, "logs", 0)).toEqual(
        traceExpressionFilters(legacy, "logs", 0)
      )
    }
  })

  test("suggests contains and completes values without replacing adjacent clauses", () => {
    const fields = collectionFilterFields.traces
    const suggestions = getFilterSuggestions("sta", 3, fields)
    expect(
      suggestions.some((item) => item.insertText === "status contains ")
    ).toBe(true)
    expect(suggestions.some((item) => item.insertText === "status : ")).toBe(
      false
    )
    for (const operator of ["contains", ":"]) {
      const query = `"invoice" status ${operator} err name = "keep"`
      const cursor = query.indexOf(" name")
      const suggestion = getFilterSuggestions(query, cursor, fields).find(
        (item) => item.label === "errored"
      )!
      expect(suggestion).toBeDefined()
      expect(
        applyFilterSuggestion(query, cursor, fields, suggestion).value
      ).toBe('"invoice" status contains "errored"  name = "keep"')
    }
  })

  test("rejects incomplete keywords and preserves field validation", () => {
    for (const query of [
      "name contains",
      "name containsvalue",
      "name contains_value",
      'name contains"value"',
      '"name" contains',
      'unknown contains "value"',
      'metadata.__proto__ contains "value"',
      'name contains "unfinished',
    ]) {
      expect(() => compileCollectionFilter("traces", query)).toThrow()
    }
    expect(parseFilterQuery('"contains : value"')[0]).toMatchObject({
      text: "contains : value",
    })
  })
})
