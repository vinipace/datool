import { expect, test } from "bun:test"
import { datasetEntryPath } from "@/src/lib/tracer/dataset-library"

test("a trailing slash creates a folder and a final name creates a dataset", () => {
  expect(datasetEntryPath.parse("foo/")).toEqual({
    kind: "folder",
    name: "foo",
    folderId: null,
  })
  expect(datasetEntryPath.parse("foo/bar/")).toEqual({
    kind: "folder",
    name: "foo/bar",
    folderId: null,
  })
  expect(datasetEntryPath.parse("foo/bar")).toEqual({
    kind: "dataset",
    name: "foo/bar",
    folderId: null,
  })
  expect(datasetEntryPath.parse("bar")).toEqual({
    kind: "dataset",
    name: "bar",
    folderId: null,
  })
  expect(datasetEntryPath.parse("  foo/  ")).toEqual({
    kind: "folder",
    name: "foo",
    folderId: null,
  })
})

test("folder shorthand preserves path validation", () => {
  for (const value of [
    "",
    "/",
    "foo//",
    "foo//bar",
    "/foo/",
    "foo/../",
    "foo/./",
    "foo\nbar/",
  ])
    expect(datasetEntryPath.safeParse(value).success).toBe(false)
  expect(datasetEntryPath.safeParse(`${"a".repeat(200)}/`).success).toBe(true)
  expect(datasetEntryPath.safeParse(`${"a".repeat(201)}/`).success).toBe(false)
})
