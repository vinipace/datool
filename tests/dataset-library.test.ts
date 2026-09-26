import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import {
  datasetParentPath,
  datasetPath,
  type DatasetLibraryEntry,
  type DatasetLibraryPage,
} from "@/src/lib/tracer/dataset-library"
import {
  getTracerProjectId,
  registerTracerProjectId,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import { TracerService } from "@/src/server/tracer/service"
import { runTracerEffect } from "@/src/server/tracer/effect"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

const fixtures: TracerDatabase[] = []
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map(closeTracerFixture))
})
async function setup() {
  const database = await createTracerFixture()
  fixtures.push(database)
  const service = new TracerService(database)
  const create = (
    name: string,
    kind: "dataset" | "folder" = "dataset",
    folderId: string | null = null
  ) =>
    runTracerEffect(service.createDatasetLibraryEntry({ name, kind, folderId }))
  const list = (folderId: string | null = null) =>
    runTracerEffect(service.listDatasetLibrary({ folderId }))
  const move = (
    entry: { id: string; kind: "folder" | "dataset" },
    folderId: string | null
  ) => runTracerEffect(service.moveDatasetLibraryEntry({ ...entry, folderId }))
  return { database, service, create, list, move }
}

describe("dataset folder library", () => {
  test("tree pages include every depth, empty folders and counts using stable ID cursors", async () => {
    const { service, create } = await setup()
    await create("Empty", "folder")
    const core = await create("Foo/Nested/Core")
    await create("Other/Case")
    await runTracerEffect(
      service.createDatasetItem(core.id, { input: { example: true } })
    )
    const entries: DatasetLibraryEntry[] = []
    let cursor: string | null = null
    do {
      const page: DatasetLibraryPage = await runTracerEffect(
        service.listDatasetLibrary({ scope: "tree", limit: 2, cursor })
      )
      expect(page.items.length <= 2).toBe(true)
      entries.push(...page.items)
      cursor = page.nextCursor
    } while (cursor)
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      "Empty",
      "Foo",
      "Foo/Nested",
      "Foo/Nested/Core",
      "Other",
      "Other/Case",
    ])
    expect(entries.find((entry) => entry.id === core.id)?.itemCount).toBe(1)
    const first = await runTracerEffect(
      service.listDatasetLibrary({ scope: "tree", limit: 1 })
    )
    const destination = entries.find(
      (entry) =>
        entry.kind === "folder" &&
        entry.id !== first.items[0].id &&
        entry.name !== datasetParentPath(first.items[0].name) &&
        !entry.name.startsWith(first.items[0].name + "/")
    )!
    const moved = await runTracerEffect(
      service.moveDatasetLibraryEntry({
        kind: first.items[0].kind,
        id: first.items[0].id,
        folderId: destination.id,
      })
    )
    expect(moved.name).not.toBe(first.items[0].name)
    const second = await runTracerEffect(
      service.listDatasetLibrary({
        scope: "tree",
        limit: 1,
        cursor: first.nextCursor,
      })
    )
    expect(second.items[0].id > first.items[0].id).toBe(true)
    await assert.rejects(
      runTracerEffect(
        service.listDatasetLibrary({ scope: "tree", folderId: "anything" })
      ),
      /cannot be scoped/
    )
  })

  test("migration preserves existing dataset keys and backfills shared parent folders", async () => {
    const { database, service, list } = await setup()
    await database.execute(
      sql`drop table dataset_folders; drop index datasets_parent_idx`
    )
    const projectId = getTracerProjectId(database)
    await database.execute(sql`insert into datasets (id,project_id,name,created_at,updated_at) values
      ('legacy-core',${projectId},'Foo/Bar/Core','2026-01-01','2026-01-01'),
      ('legacy-other',${projectId},'Foo/Bar/Other','2026-01-01','2026-01-01'),
      ('legacy-root',${projectId},'Root','2026-01-01','2026-01-01')`)
    await database.execute(
      sql.raw(await readFile("migrations/0005_dataset_folders.sql", "utf8"))
    )
    const roots = (await list()).items
    expect(roots.map((row) => row.name)).toEqual(["Foo", "Root"])
    const bar = (await list(roots[0].id)).items[0]
    expect((await list(bar.id)).items.map((row) => row.id)).toEqual([
      "legacy-core",
      "legacy-other",
    ])
    expect(
      (await runTracerEffect(service.getDataset("legacy-core"))).name
    ).toBe("Foo/Bar/Core")
  })

  test("validates path segments without treating literal wildcard characters as patterns", () => {
    for (const path of [
      "",
      "/Foo",
      "Foo/",
      "Foo//Core",
      "Foo/../Core",
      "Foo/./Core",
      "Foo/ Core",
      "Foo\nCore",
    ])
      expect(datasetPath.safeParse(path).success).toBe(false)
    for (const path of ["Foo/Bar/Core", "50%_done/🧪/Core", "Support quality"])
      expect(datasetPath.safeParse(path).success).toBe(true)
  })

  test("creates nested paths and relative paths with persistent empty folders", async () => {
    const { service, create, list, move } = await setup()
    const core = await create("Foo/Bar/Core")
    const foo = (await list()).items[0]
    const bar = (await list(foo.id)).items[0]
    expect(foo.name).toBe("Foo")
    expect(bar.name).toBe("Foo/Bar")
    expect(
      core.folders
        .map((folder) => ({ id: folder.id, name: folder.name }))
        .sort((a, b) => a.name.localeCompare(b.name))
    ).toEqual([
      { id: foo.id, name: "Foo" },
      { id: bar.id, name: "Foo/Bar" },
    ])
    expect((await list(bar.id)).items.map((row) => row.name)).toEqual([
      "Foo/Bar/Core",
    ])
    expect((await runTracerEffect(service.getDataset(core.id))).name).toBe(
      "Foo/Bar/Core"
    )
    await move(core, null)
    expect((await list(bar.id)).items).toEqual([])
    expect((await list(foo.id)).items[0].id).toBe(bar.id)
    const next = await create("Nested/Next", "dataset", bar.id)
    expect(next.name).toBe("Foo/Bar/Nested/Next")
    const empty = await create("Empty/Sub", "folder", foo.id)
    expect(empty.folders.map((folder) => folder.name).sort()).toEqual([
      "Foo",
      "Foo/Empty",
    ])
    expect((await list(empty.id)).items).toEqual([])
  })

  test("moves a folder subtree atomically and keeps dataset/item identities and exports", async () => {
    const { service, create, list, move } = await setup()
    const core = await create("Foo/Bar/Core")
    const item = await runTracerEffect(
      service.createDatasetItem(core.id, { input: { test: true } })
    )
    const target = await create("Target", "folder")
    const foo = (await list()).items.find((row) => row.name === "Foo")!
    const bar = (await list(foo.id)).items[0]
    await move(foo, target.id)
    expect((await list(target.id)).items[0].id).toBe(foo.id)
    expect((await list(foo.id)).items[0]).toMatchObject({
      id: bar.id,
      name: "Target/Foo/Bar",
    })
    expect((await list(bar.id)).items[0]).toMatchObject({
      id: core.id,
      name: "Target/Foo/Bar/Core",
      itemCount: 1,
    })
    const detail = await runTracerEffect(service.getDataset(core.id))
    expect(detail.items[0].id).toBe(item.id)
    const exported = await runTracerEffect(
      service.resources.export("dataset", "Target/Foo/Bar/Core")
    )
    expect(exported).toBeDefined()
    await move(foo, null)
    expect((await runTracerEffect(service.getDataset(core.id))).name).toBe(
      "Foo/Bar/Core"
    )
  })

  test("rejects cycles, occupied destinations and failed creates without leaving partial folders", async () => {
    const { service, create, list, move } = await setup()
    const core = await create("Foo/Bar/Core")
    const foo = (await list()).items[0]
    const bar = (await list(foo.id)).items[0]
    await assert.rejects(move(foo, bar.id), new RegExp("descendants"))
    await assert.rejects(move(foo, foo.id), new RegExp("descendants"))
    await create("Core")
    await assert.rejects(move(core, null), new RegExp("already exists"))
    expect((await list(bar.id)).items[0].id).toBe(core.id)
    await assert.rejects(create("Core/Child"), new RegExp("already exists"))
    await assert.rejects(
      runTracerEffect(
        service.createDataset({ id: core.id, name: "Rollback/Inner/Duplicate" })
      )
    )
    expect((await list()).items.map((row) => row.name)).not.toContain(
      "Rollback"
    )
  })

  test("serializes concurrent creates and reciprocal folder moves", async () => {
    const { create, list, move } = await setup()
    const results = await Promise.all([create("Shared/A"), create("Shared/B")])
    const shared = (await list()).items[0]
    expect((await list(shared.id)).items).toHaveLength(2)
    expect(results).toHaveLength(2)
    const a = await create("A", "folder"),
      b = await create("B", "folder")
    const moves = await Promise.allSettled([move(a, b.id), move(b, a.id)])
    expect(
      moves.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(moves.filter((result) => result.status === "rejected")).toHaveLength(
      1
    )
  })

  test("handles unicode and wildcard paths and returns bounded, searchable child pages", async () => {
    const { service, create, list, move } = await setup()
    const core = await create("🧪%_/Sub/Core")
    const control = await create("🧪XX/Sub/Control")
    const folder = (await list()).items.find((row) => row.name === "🧪%_")!
    const target = await create("Target", "folder")
    await move(folder, target.id)
    expect((await runTracerEffect(service.getDataset(core.id))).name).toBe(
      "Target/🧪%_/Sub/Core"
    )
    expect((await runTracerEffect(service.getDataset(control.id))).name).toBe(
      "🧪XX/Sub/Control"
    )
    const first = await runTracerEffect(
      service.listDatasetLibrary({ limit: 1 })
    )
    expect(first.items).toHaveLength(1)
    expect(first.nextCursor).toBeTruthy()
    const second = await runTracerEffect(
      service.listDatasetLibrary({ limit: 1, cursor: first.nextCursor })
    )
    expect(second.items[0].id).not.toBe(first.items[0].id)
    const search = await runTracerEffect(
      service.listDatasetLibrary({ filter: "Sub/Core" })
    )
    expect(search.items.map((row) => row.id)).toEqual([core.id])
  })

  test("dataset renames and resource imports maintain folders and description search", async () => {
    const { service, create, list } = await setup()
    const entry = await create("Original")
    await runTracerEffect(
      service.patchDataset(entry.id, {
        name: "Renamed/Nested/Case",
        description: "refund quality",
      })
    )
    const renamed = (await list()).items.find(
      (item) => item.name === "Renamed"
    )!
    expect((await list(renamed.id)).items[0].name).toBe("Renamed/Nested")
    const search = await runTracerEffect(
      service.listDatasetLibrary({ filter: "refund quality" })
    )
    expect(search.items[0].id).toBe(entry.id)
    await runTracerEffect(
      service.resources.push({
        format: 1,
        kind: "dataset",
        key: "Imported/Tests/Case",
        description: "",
        items: [],
      })
    )
    const imported = (await list()).items.find(
      (item) => item.name === "Imported"
    )!
    expect((await list(imported.id)).items[0].name).toBe("Imported/Tests")
    await create("Occupied", "folder")
    await assert.rejects(
      runTracerEffect(
        service.resources.push({
          format: 1,
          kind: "dataset",
          key: "Occupied",
          description: "",
          items: [],
        })
      ),
      /already a folder/
    )
  })

  test("rejects moves that exceed descendant path limits without partial changes", async () => {
    const { service, create, list, move } = await setup()
    const entry = await create("A/" + "x".repeat(195))
    const a = (await list()).items[0]
    const target = await create("LongTarget", "folder")
    await assert.rejects(move(a, target.id), /longer than 200/)
    expect((await runTracerEffect(service.getDataset(entry.id))).name).toBe(
      entry.name
    )
    expect((await list(target.id)).items).toEqual([])
  })

  test("rejects cross-project folders and dataset sources", async () => {
    const { database, create, list, move } = await setup()
    const foreign = await create("Private", "folder")
    const source = await create("Private/Core")
    const original = getTracerProjectId(database)
    const projectId = crypto.randomUUID()
    await database.execute(sql`insert into project (id, organization_id, name, slug, created_at, updated_at)
      select ${projectId}, organization_id, 'Other', ${projectId}, now(), now() from project where id=${original}`)
    registerTracerProjectId(database, projectId)
    try {
      const other = new TracerService(database)
      expect(
        (await runTracerEffect(other.listDatasetLibrary({ scope: "tree" })))
          .items
      ).toEqual([])
      await assert.rejects(
        runTracerEffect(other.listDatasetLibrary({ folderId: foreign.id })),
        new RegExp("not found")
      )
      await assert.rejects(
        runTracerEffect(
          other.createDatasetLibraryEntry({
            name: "Leak",
            kind: "dataset",
            folderId: foreign.id,
          })
        ),
        new RegExp("not found")
      )
      await assert.rejects(
        runTracerEffect(
          other.moveDatasetLibraryEntry({
            id: source.id,
            kind: "dataset",
            folderId: null,
          })
        ),
        new RegExp("not found")
      )
    } finally {
      registerTracerProjectId(database, original)
    }
    await assert.rejects(
      move(source, "missing-folder"),
      new RegExp("not found")
    )
    expect((await list(foreign.id)).items[0].id).toBe(source.id)
  })
})
