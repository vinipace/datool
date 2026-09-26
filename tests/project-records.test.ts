import { describe, expect, test } from "bun:test"

import {
  MAX_RECORD_DATA_BYTES,
  parsePagination,
  parseProjectCreate,
  parseProjectUpdate,
  parseRecordCreate,
  parseRecordUpdate,
  serializeRecordData,
} from "@/lib/project-records"

describe("project record input boundaries", () => {
  test("only accepts the public project create fields and canonicalizes a generated slug", () => {
    expect(parseProjectCreate({ name: "Avaliação de modelos" })).toEqual({
      name: "Avaliação de modelos",
      slug: "avaliacao-de-modelos",
    })
    expect(parseProjectCreate({ name: "Demo", organizationId: "other-org" })).toBeNull()
    expect(parseProjectCreate({ name: "Demo", id: "client-chosen" })).toBeNull()
    expect(parseProjectCreate({ name: "Demo", slug: "not valid" })).toBeNull()
  })

  test("rejects project mutation attempts that have no whitelisted change", () => {
    expect(parseProjectUpdate({})).toBeNull()
    expect(parseProjectUpdate({ projectId: "another-project" })).toBeNull()
    expect(parseProjectUpdate({ name: "  Renamed project  " })).toEqual({ name: "Renamed project" })
  })

  test("only accepts object data and does not permit record ownership fields", () => {
    expect(parseRecordCreate({ kind: "trace", name: "Checkout", data: { traceId: "trace_1" } })).toMatchObject({
      kind: "trace",
      name: "Checkout",
      data: { traceId: "trace_1" },
    })
    expect(parseRecordCreate({ kind: "trace", name: "Checkout", data: [], projectId: "other-project" })).toBeNull()
    expect(parseRecordCreate({ kind: "unknown", name: "Checkout", data: {} })).toBeNull()
    expect(parseRecordUpdate({ kind: "dataset" })).toBeNull()
    expect(parseRecordUpdate({ data: { version: 2 } })).toMatchObject({ data: { version: 2 } })
  })

  test("bounds pagination and serialized record data", () => {
    expect(parsePagination(new URLSearchParams("page=2&pageSize=50"))).toEqual({ page: 2, pageSize: 50, offset: 50 })
    expect(parsePagination(new URLSearchParams("page=0"))).toBeNull()
    expect(parsePagination(new URLSearchParams("pageSize=101"))).toBeNull()
    expect(serializeRecordData({ body: "x".repeat(MAX_RECORD_DATA_BYTES) })).toBeNull()
  })
})
