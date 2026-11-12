import { expect, test } from "bun:test"
import { DatoolError } from "@datool/sdk/agents"
import {
  createCompanyContextLoader,
  loadCompanyContext,
} from "../examples/react-agent/lib/company-context"

test("overlapping loads share one drive read and never cache across workspaces or later edits", async () => {
  const load = createCompanyContextLoader()
  let reads = 0
  let finish!: (value: string) => void
  const files = {
    read: () => {
      reads++
      return new Promise<string>((resolve) => {
        finish = resolve
      })
    },
    write: async () => {},
  }
  const first = load("acme-drive", files, "acme")
  const duplicate = load("acme-drive", files, "acme")
  expect(reads).toBe(1)
  expect(first).toBe(duplicate)
  expect(
    await load(
      "orbit-drive",
      { ...files, read: async () => "Orbit context" },
      "orbit"
    )
  ).toBe("Orbit context")
  finish("Acme context")
  expect(await first).toBe("Acme context")
  expect(await duplicate).toBe("Acme context")
  expect(
    await load(
      "acme-drive",
      { ...files, read: async () => "Edited Acme context" },
      "acme"
    )
  ).toBe("Edited Acme context")
})

test("each demo workspace seeds its own missing company file", async () => {
  const saved = new Map<string, string>()
  for (const workspace of ["acme", "orbit"] as const) {
    const content = await loadCompanyContext(
      {
        read: async () => {
          throw new DatoolError("File or directory not found.", 400)
        },
        write: async (path, content) => {
          saved.set(`${workspace}/${path}`, content)
        },
      },
      workspace
    )
    expect(saved.get(`${workspace}/context/company.md`)).toBe(content)
  }
  expect(saved.get("acme/context/company.md")).toContain("Acme Studio")
  expect(saved.get("orbit/context/company.md")).toContain("Orbit Labs")
  expect(saved.get("orbit/context/company.md")).not.toContain("Acme")
})

test("loading preserves saved company context, including an empty file", async () => {
  for (const content of ["Our own company context", ""]) {
    let writes = 0
    expect(
      await loadCompanyContext(
        {
          read: async () => content,
          write: async () => {
            writes++
          },
        },
        "orbit"
      )
    ).toBe(content)
    expect(writes).toBe(0)
  }
})

test("read failures never overwrite saved company context", async () => {
  for (const error of [
    new DatoolError("Not authorized", 403),
    new DatoolError("Connection not found", 404),
    new DatoolError("Drive unavailable", 503),
  ]) {
    let writes = 0
    const result = await loadCompanyContext(
      {
        read: async () => {
          throw error
        },
        write: async () => {
          writes++
        },
      },
      "orbit"
    ).then(
      () => null,
      (failure: unknown) => failure
    )
    expect(result).toBe(error)
    expect(writes).toBe(0)
  }
})
