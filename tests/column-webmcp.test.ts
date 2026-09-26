import { describe, expect, test } from "bun:test"
import { createComputedColumnStore } from "../src/lib/tracer/computed-column-store"
import {
  createColumnTools,
  registerColumnTools,
  type PageTool,
  type PageModelContext,
} from "../src/lib/tracer/column-webmcp"

function fixture() {
  const data = new Map<string, string>()
  let failWrites = false
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (failWrites) throw new Error("Quota exceeded")
      data.set(key, value)
    },
  }
  const store = createComputedColumnStore("run-1", () => storage)
  store.load()
  const tools = createColumnTools(store)
  const call = (name: string, input: unknown, signal?: AbortSignal) =>
    tools.find((tool) => tool.name === name)!.execute(input, { signal })
  return {
    store,
    tools,
    data,
    storage,
    call,
    failWrites: () => {
      failWrites = true
    },
  }
}
const definition = {
  runId: "run-1",
  id: "cost",
  name: "Cost",
  code: "R${{row.metrics.cost*5.5}}",
  mode: "template",
}

describe("computed column WebMCP CRUD", () => {
  test("creates, reads, partially updates and deletes persistent UI state", async () => {
    const { store, storage, call } = fixture()
    expect(
      (await call("create_eval_column", definition)).structuredContent?.created
    ).toBe(true)
    const updated = await call("update_eval_column", {
      runId: "run-1",
      id: "cost",
      name: "BRL",
    })
    expect(updated.structuredContent?.column).toEqual({
      id: "cost",
      name: "BRL",
      code: definition.code,
      mode: "template",
    })
    const reloaded = createComputedColumnStore("run-1", () => storage)
    reloaded.load()
    expect(reloaded.getSnapshot().columns).toEqual(store.getSnapshot().columns)
    expect(
      (await call("get_eval_column", { runId: "run-1", id: "cost" }))
        .structuredContent?.column
    ).toEqual(store.getSnapshot().columns[0])
    expect(
      (await call("delete_eval_column", { runId: "run-1", id: "cost" }))
        .structuredContent?.deleted
    ).toBe(true)
    expect(store.getSnapshot().columns).toEqual([])
    expect(
      (await call("delete_eval_column", { runId: "run-1", id: "cost" }))
        .structuredContent?.deleted
    ).toBe(false)
    expect(
      (await call("get_eval_column", { runId: "run-1", id: "cost" })).isError
    ).toBe(true)
  })
  test("back-to-back calls and UI edits share the latest state without lost updates", async () => {
    const { store, call } = fixture()
    await Promise.all([
      call("create_eval_column", definition),
      call("create_eval_column", { ...definition, id: "tokens" }),
    ])
    expect(store.getSnapshot().columns.map((column) => column.id)).toEqual([
      "cost",
      "tokens",
    ])
    store.update((current) =>
      current.map((column) => ({ ...column, name: "UI edit" }))
    )
    expect(
      (await call("get_eval_column", { runId: "run-1", id: "cost" }))
        .structuredContent?.column
    ).toMatchObject({ name: "UI edit" })
    await call("update_eval_column", {
      runId: "run-1",
      id: "tokens",
      code: "row.metrics.totalTokens",
      mode: "expression",
    })
    expect(store.getSnapshot().columns[0].name).toBe("UI edit")
    expect(store.getSnapshot().columns[1].mode).toBe("expression")
  })
  test("retries with an explicit ID are idempotent and conflicting definitions fail", async () => {
    const { store, call } = fixture()
    await call("create_eval_column", definition)
    expect(
      (await call("create_eval_column", definition)).structuredContent?.created
    ).toBe(false)
    expect(
      (await call("create_eval_column", { ...definition, code: "42" })).isError
    ).toBe(true)
    expect(store.getSnapshot().columns).toHaveLength(1)
  })
  test("rejects wrong runs, invalid inputs, unknown fields and cancelled mutations", async () => {
    const { store, call } = fixture()
    for (const input of [
      null,
      {},
      { ...definition, runId: "run-2" },
      { ...definition, name: "   " },
      { ...definition, code: " " },
      { ...definition, mode: "invalid" },
      { ...definition, extra: true },
      { ...definition, code: "x".repeat(16001) },
    ]) {
      expect((await call("create_eval_column", input)).isError).toBe(true)
    }
    const controller = new AbortController()
    controller.abort()
    expect(
      (await call("create_eval_column", definition, controller.signal)).isError
    ).toBe(true)
    expect(
      (await call("update_eval_column", { runId: "run-1", id: "cost" })).isError
    ).toBe(true)
    expect(store.getSnapshot().columns).toEqual([])
  })
  test("failed storage writes roll back tool mutations instead of claiming success", async () => {
    const { store, call, failWrites, data } = fixture()
    await call("create_eval_column", definition)
    const before = JSON.stringify(store.getSnapshot().columns)
    failWrites()
    expect(
      (
        await call("update_eval_column", {
          runId: "run-1",
          id: "cost",
          name: "Changed",
        })
      ).isError
    ).toBe(true)
    expect(
      (await call("delete_eval_column", { runId: "run-1", id: "cost" })).isError
    ).toBe(true)
    expect(JSON.stringify(store.getSnapshot().columns)).toBe(before)
    expect(data.get("datool:eval-columns:run-1")).toBe(before)
  })
  test("does not overwrite unreadable saved state", async () => {
    const { store, call, data } = fixture()
    const broken = createComputedColumnStore("broken", () => ({
      getItem: () => "not-json",
      setItem: () => {
        throw new Error("must not write")
      },
    }))
    broken.load()
    const result = await createColumnTools(broken)[2].execute({
      ...definition,
      runId: "broken",
    })
    expect(result.isError).toBe(true)
    expect(broken.getSnapshot().loaded).toBe(false)
    data.set("datool:eval-columns:other-run", "[]")
    await call("create_eval_column", definition)
    expect(data.get("datool:eval-columns:other-run")).toBe("[]")
    expect(store.getSnapshot().loaded).toBe(true)
  })
})

describe("WebMCP lifecycle", () => {
  test("legacy cleanup removes only its own tools and disables stale callbacks", async () => {
    const { tools } = fixture()
    const registry = new Map<string, PageTool>([["unrelated", tools[0]]])
    const context: PageModelContext = {
      registerTool: (tool) => {
        if (registry.has(tool.name)) throw new Error("Duplicate")
        registry.set(tool.name, tool)
      },
      unregisterTool: (name) => {
        registry.delete(name)
      },
    }
    const dispose = registerColumnTools(context, tools, (error) => {
      throw error
    })
    const stale = registry.get("create_eval_column")!
    dispose()
    expect([...registry.keys()]).toEqual(["unrelated"])
    expect((await stale.execute(definition)).isError).toBe(true)
    registerColumnTools(context, tools, (error) => {
      throw error
    })()
    expect([...registry.keys()]).toEqual(["unrelated"])
  })
  test("modern registrations use abort signals and handle async rejections", async () => {
    const { tools } = fixture()
    const registry = new Map<string, PageTool>()
    const context: PageModelContext = {
      registerTool: async (tool, options) => {
        registry.set(tool.name, tool)
        options!.signal.addEventListener(
          "abort",
          () => registry.delete(tool.name),
          { once: true }
        )
      },
    }
    const errors: unknown[] = []
    const dispose = registerColumnTools(context, tools, (error) =>
      errors.push(error)
    )
    expect(registry.size).toBe(5)
    dispose()
    expect(registry.size).toBe(0)
    registerColumnTools(
      {
        registerTool: async () => {
          throw new Error("Denied")
        },
      },
      tools,
      (error) => errors.push(error)
    )
    await Promise.resolve()
    expect(errors).toHaveLength(1)
  })
  test("failed registration preserves existing unrelated tools", () => {
    const { tools } = fixture()
    const registry = new Map([[tools[1].name, tools[1]]])
    const errors: unknown[] = []
    registerColumnTools(
      {
        registerTool: (tool) => {
          if (registry.has(tool.name)) throw new Error("Duplicate")
          registry.set(tool.name, tool)
        },
        unregisterTool: (name) => {
          registry.delete(name)
        },
      },
      tools,
      (error) => errors.push(error)
    )
    expect([...registry.keys()]).toEqual([tools[1].name])
    expect(errors).toHaveLength(1)
  })
})
