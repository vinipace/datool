import { test, expect } from "bun:test"
import { access } from "node:fs/promises"
import ledger from "./fixtures/read-paths.json"
import { semanticCatalog } from "@/src/server/metrics/registry"

test("every registered semantic model declares its bounded page in the read ledger", async () => {
  const declared = ledger.paths
    .filter((path) => path.surface === "semantic")
    .map((path) => path.resource)
    .sort()
  expect(declared).toEqual(
    semanticCatalog
      .metadata()
      .models.map((model) => model.name)
      .sort()
  )
  for (const path of ledger.paths) {
    await access(path.entry)
    expect(path.scope.startsWith("project")).toBe(true)
    if (path.pageLimit === null) expect("exception" in path).toBe(true)
    else expect(path.pageLimit > 0 && path.pageLimit <= 5000).toBe(true)
  }
})
