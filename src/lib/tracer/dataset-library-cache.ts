import {
  datasetEntryPath,
  datasetLeafName,
  datasetParentPath,
  datasetPath,
  type CreatedLibraryEntry,
  type CreateLibraryEntry,
  type DatasetLibraryEntry,
  type DatasetLibraryPage,
  type MoveLibraryEntry,
} from "./dataset-library"

export type FolderTarget = { id: string | null; name: string }
export type DatasetLibraryApi = {
  library: (options: {
    cursor?: string
    limit: number
  }) => Promise<DatasetLibraryPage>
  addEntry: (input: CreateLibraryEntry) => Promise<CreatedLibraryEntry>
  moveEntry: (input: MoveLibraryEntry) => Promise<{ id: string; name: string }>
}
type Operation =
  | { id: number; kind: "create"; entries: DatasetLibraryEntry[]; name: string }
  | { id: number; kind: "move"; entry: DatasetLibraryEntry; name: string }
type Failure = { id: number; message: string; retry: () => void }
const within = (path: string, parent: string) =>
  path === parent || path.startsWith(`${parent}/`)
const related = (a: string, b: string) => within(a, b) || within(b, a)
const temporary = (id: string | null) => !!id?.startsWith("pending:")
const renamed = (entry: DatasetLibraryEntry, from: string, to: string) =>
  within(entry.name, from)
    ? { ...entry, name: to + entry.name.slice(from.length) }
    : entry

/** One project tree, fetched in bounded batches; folder navigation is entirely local. */
export class DatasetLibraryCache {
  private records = new Map<
    string,
    { entry: DatasetLibraryEntry; revision: number }
  >()
  private loaded = false
  private loading: Promise<void> | null = null
  private error: Error | null = null
  private createdFolders = new Set<string>()
  private projection: {
    version: number
    entries: DatasetLibraryEntry[]
    children: Map<string, DatasetLibraryEntry[]>
  } | null = null
  private operations = new Map<number, Operation>()
  private completedMoves: { revision: number; from: string; to: string }[] = []
  private listeners = new Set<() => void>()
  private revision = 0
  private sequence = 0
  private version = 0
  failures: Failure[] = []

  constructor(private api: DatasetLibraryApi) {}

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  getSnapshot = () => this.version
  private emit() {
    this.version++
    this.listeners.forEach((listener) => listener())
  }
  private entries() {
    if (this.projection?.version === this.version)
      return this.projection.entries
    const entries = new Map(
      [...this.records].map(([id, record]) => [id, record.entry])
    )
    for (const operation of this.operations.values()) {
      if (operation.kind === "create") {
        for (const entry of operation.entries) {
          if (
            ![...entries.values()].some(
              (existing) => existing.name === entry.name
            )
          )
            entries.set(entry.id, entry)
        }
      } else {
        entries.set(
          operation.entry.id,
          entries.get(operation.entry.id) ?? operation.entry
        )
        for (const [id, entry] of entries)
          entries.set(id, renamed(entry, operation.entry.name, operation.name))
      }
    }
    const sorted = [...entries.values()].sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    const children = new Map<string, DatasetLibraryEntry[]>()
    for (const entry of sorted) {
      const parent = datasetParentPath(entry.name)
      const siblings = children.get(parent) ?? []
      siblings.push(entry)
      children.set(parent, siblings)
    }
    this.projection = { version: this.version, entries: sorted, children }
    return sorted
  }
  page(target: FolderTarget, filter = "") {
    const entries = this.entries()
    const items = filter
      ? entries.filter((entry) =>
          `${entry.name} ${entry.description ?? ""}`
            .toLowerCase()
            .includes(filter.toLowerCase())
        )
      : (this.projection!.children.get(target.name) ?? [])
    const hasData =
      this.loaded ||
      items.length > 0 ||
      temporary(target.id) ||
      this.createdFolders.has(target.id ?? "")
    return {
      items,
      data: hasData ? { items } : null,
      error: this.error,
      isLoading: !hasData && !this.error,
      isRefreshing: !!this.loading && hasData,
      refresh: () => this.refresh(),
    }
  }
  load(mode: "cached" | "refresh" = "cached"): Promise<void> {
    if (this.loading) return this.loading
    if (this.loaded && mode === "cached") return Promise.resolve()
    this.loading = this.readTree().finally(() => {
      this.loading = null
      this.completedMoves = []
      this.emit()
    })
    this.emit()
    return this.loading
  }
  private async readTree() {
    const revision = this.revision
    const fetched = new Map<string, DatasetLibraryEntry>()
    const cursors = new Set<string>()
    let cursor: string | undefined
    try {
      do {
        const page = await this.api.library({ cursor, limit: 200 })
        for (const entry of page.items) fetched.set(entry.id, entry)
        cursor = page.nextCursor ?? undefined
        if (cursor) {
          if (cursors.has(cursor))
            throw new Error(
              "Could not finish loading the dataset tree. Please retry."
            )
          cursors.add(cursor)
        }
      } while (cursor)
      // Install a complete tree together, so unopened and empty folders are ready.
      for (let entry of fetched.values()) {
        for (const move of this.completedMoves) {
          if (move.revision > revision)
            entry = renamed(entry, move.from, move.to)
        }
        for (const operation of this.operations.values()) {
          if (operation.kind === "move")
            entry = renamed(entry, operation.name, operation.entry.name)
        }
        const existing = this.records.get(entry.id)
        if (!existing || existing.revision <= revision) {
          this.records.set(entry.id, { entry, revision })
        }
      }
      for (const [id, record] of this.records) {
        if (
          !fetched.has(id) &&
          record.revision <= revision &&
          !this.isPending(record.entry)
        )
          this.records.delete(id)
      }
      this.loaded = true
      this.error = null
    } catch (error) {
      this.error =
        error instanceof Error
          ? error
          : new Error("Could not load the dataset tree.")
    }
  }
  refresh() {
    return this.load("refresh")
  }
  isPending(entry: DatasetLibraryEntry) {
    return (
      temporary(entry.id) ||
      [...this.operations.values()].some((operation) =>
        operation.kind === "create"
          ? related(entry.name, operation.name)
          : related(entry.name, operation.entry.name) ||
            related(entry.name, operation.name)
      )
    )
  }
  canAdd(target: FolderTarget) {
    return ![...this.operations.values()].some(
      (operation) =>
        operation.kind === "move" &&
        (within(target.name, operation.entry.name) ||
          within(target.name, operation.name))
    )
  }
  canMove(entry: DatasetLibraryEntry, target: FolderTarget) {
    const destination = target.name
      ? `${target.name}/${datasetLeafName(entry.name)}`
      : datasetLeafName(entry.name)
    return (
      !this.isPending(entry) &&
      !temporary(target.id) &&
      this.canAdd(target) &&
      ![...this.operations.values()].some(
        (operation) =>
          operation.kind === "move" &&
          (related(destination, operation.entry.name) ||
            related(destination, operation.name))
      ) &&
      datasetParentPath(entry.name) !== target.name &&
      !(entry.kind === "folder" && within(target.name, entry.name))
    )
  }
  private currentTarget(target: FolderTarget) {
    return (
      this.entries().find(
        (entry) => entry.kind === "folder" && entry.id === target.id
      ) ?? target
    )
  }
  create(value: string, target: FolderTarget) {
    target = this.currentTarget(target)
    if (!this.canAdd(target))
      throw new Error(
        "This folder is still moving. Try again when it finishes."
      )
    const parsed = datasetEntryPath.safeParse(value)
    if (!parsed.success) throw new Error(parsed.error.issues[0].message)
    const fullPath = datasetPath.safeParse(
      target.name ? `${target.name}/${parsed.data.name}` : parsed.data.name
    )
    if (!fullPath.success) throw new Error(fullPath.error.issues[0].message)
    const name = fullPath.data
    if (!this.canAdd({ id: null, name }))
      throw new Error(
        "This folder is still moving. Try again when it finishes."
      )
    const current = this.entries()
    if (current.some((entry) => entry.name === name))
      throw new Error(`“${name}” already exists.`)
    const parts = name.split("/")
    const timestamp = new Date().toISOString()
    const entries = parts.map((_, index): DatasetLibraryEntry => {
      const path = parts.slice(0, index + 1).join("/")
      const kind = index === parts.length - 1 ? parsed.data.kind : "folder"
      if (
        current.some((entry) => entry.name === path && entry.kind === "dataset")
      )
        throw new Error(`“${path}” is already a dataset.`)
      return {
        id: `pending:${path}`,
        kind,
        name: path,
        description: null,
        itemCount: kind === "folder" ? null : 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      }
    })
    const id = ++this.sequence
    this.operations.set(id, { id, kind: "create", entries, name })
    this.revision++
    this.emit()
    // Full paths let another inline create use a parent whose ID is still saving.
    void this.api.addEntry({ ...parsed.data, name, folderId: null }).then(
      (result) => {
        const revision = ++this.revision
        for (const entry of [...result.folders, result])
          this.records.set(entry.id, { entry, revision })
        // The newly inserted folder is empty apart from our other pending writes.
        // Keep its Add row ready instead of loading it again after ID replacement.
        if (result.kind === "folder") this.createdFolders.add(result.id)
        this.operations.delete(id)
        this.emit()
      },
      (error) =>
        this.fail(id, `Could not create “${name}”`, error, () =>
          this.create(value, target)
        )
    )
    return entries
  }
  move(entry: DatasetLibraryEntry, target: FolderTarget) {
    entry = this.entries().find((current) => current.id === entry.id) ?? entry
    target = this.currentTarget(target)
    if (!this.canMove(entry, target)) return false
    const name = target.name
      ? `${target.name}/${datasetLeafName(entry.name)}`
      : datasetLeafName(entry.name)
    if (
      this.entries().some(
        (other) => other.name === name && other.id !== entry.id
      )
    )
      throw new Error(`“${name}” already exists.`)
    const id = ++this.sequence
    this.operations.set(id, { id, kind: "move", entry, name })
    this.revision++
    this.emit()
    void this.api
      .moveEntry({ kind: entry.kind, id: entry.id, folderId: target.id })
      .then(
        (result) => {
          const revision = ++this.revision
          this.records.set(
            entry.id,
            this.records.get(entry.id) ?? { entry, revision }
          )
          for (const [key, record] of this.records) {
            if (within(record.entry.name, entry.name))
              this.records.set(key, {
                entry: {
                  ...renamed(record.entry, entry.name, result.name),
                  updatedAt: new Date().toISOString(),
                },
                revision,
              })
          }
          if (this.loading)
            this.completedMoves.push({
              revision,
              from: entry.name,
              to: result.name,
            })
          this.operations.delete(id)
          this.emit()
        },
        (error) =>
          this.fail(id, `Could not move “${entry.name}”`, error, () =>
            this.move(entry, target)
          )
      )
    return true
  }
  private fail(
    id: number,
    label: string,
    error: unknown,
    retry: () => unknown
  ) {
    this.operations.delete(id)
    this.revision++
    this.failures.push({
      id,
      message: `${label}. ${error instanceof Error ? error.message : "Try again."}`,
      retry: () => {
        this.dismiss(id)
        try {
          if (retry() === false)
            throw new Error(
              "This entry is still saving. Try again when it finishes."
            )
        } catch (error) {
          this.fail(id, label, error, retry)
        }
      },
    })
    this.emit()
  }
  dismiss(id: number) {
    this.failures = this.failures.filter((failure) => failure.id !== id)
    this.emit()
  }
}

/** The layout scope object survives page navigation and is discarded on project/account exit. */
const projectCaches = new WeakMap<object, DatasetLibraryCache>()
export function getDatasetLibraryCache(scope: object, api: DatasetLibraryApi) {
  let cache = projectCaches.get(scope)
  if (!cache) {
    cache = new DatasetLibraryCache(api)
    projectCaches.set(scope, cache)
  }
  return cache
}
