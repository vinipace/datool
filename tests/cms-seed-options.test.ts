import { expect, test } from "bun:test"
import { cmsSeedOptions } from "../scripts/cms-seed-options"

const production = "postgres://user:secret@database:5432/datool_db"

test("ordinary production seeding remains refused without an explicit target", () => {
  expect(() => cmsSeedOptions([], production)).toThrow(
    "Remote databases are refused"
  )
  expect(() => cmsSeedOptions(["--apply"], production)).toThrow(
    "requires --database"
  )
})

test("explicit database targeting previews by default and excludes demo fixtures", () => {
  expect(cmsSeedOptions(["--database", "datool_db"], production)).toEqual({
    dryRun: true,
    includeDraftExample: false,
  })
  expect(
    cmsSeedOptions(["--database", "datool_db", "--apply"], production)
  ).toEqual({
    dryRun: false,
    includeDraftExample: false,
  })
})

test("wrong, missing, non-Postgres, and misspelled targets are rejected", () => {
  expect(() =>
    cmsSeedOptions(["--database", "another_db", "--apply"], production)
  ).toThrow("must match")
  expect(() => cmsSeedOptions(["--database", "datool_db"], undefined)).toThrow(
    "Set PAYLOAD_DATABASE_URL"
  )
  expect(() =>
    cmsSeedOptions(["--database", "datool_db"], "https://database/datool_db")
  ).toThrow("must match")
  expect(() => cmsSeedOptions(["--databse", "datool_db"], production)).toThrow()
})

test("the disposable local demo keeps its existing behavior", () => {
  expect(cmsSeedOptions([], "postgres://localhost/datool_cms_test")).toEqual({
    dryRun: false,
    includeDraftExample: true,
  })
})
