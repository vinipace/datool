import type { DatasetFieldSchemas, DatasetItem } from "./contracts"
import { parseItemDraft, type ItemDraft } from "./dataset-editor"
import { canonicalJson } from "./resource-document"
import { datasetFieldErrors, datasetFieldLabels, datasetFields } from "./dataset-schemas"

export type AutosaveStatus = "saved" | "pending" | "saving" | "invalid" | "error"
export type ItemValues = ReturnType<typeof parseItemDraft>
export type AutosaveState = {
  item: DatasetItem
  preview: DatasetItem
  isNew: boolean
  status: AutosaveStatus
  error?: string
}
type Entry = AutosaveState & {
  draft: ItemDraft
  generation: number
  timer?: ReturnType<typeof setTimeout>
  inFlight?: Promise<void>
  removed?: boolean
}

const valuesOf = (item: DatasetItem): ItemValues => ({
  input: item.input,
  expectedOutput: item.expectedOutput,
  metadata: item.metadata,
  sourceTraceId: item.sourceTraceId,
})

/** One request per row at a time; edits made during a request stay queued. */
export class DatasetAutosave {
  private entries = new Map<string, Entry>()
  private detached = false
  constructor(private options: {
    schemas: () => DatasetFieldSchemas
    save: (item: DatasetItem, values: ItemValues, isNew: boolean) => Promise<DatasetItem>
    changed: (id: string, state: AutosaveState) => void
    saved: (item: DatasetItem, wasNew: boolean) => void
    delay?: number
  }) {}

  private emit(entry: Entry) {
    if (!this.detached && !entry.removed) this.options.changed(entry.item.id, {
      item: entry.item, preview: entry.preview, isNew: entry.isNew,
      status: entry.status, error: entry.error,
    })
  }

  private parse(entry: Entry) {
    const values = parseItemDraft(entry.draft)
    const schemas = this.options.schemas()
    for (const field of datasetFields) {
      if (!schemas[field]?.enforced) continue
      const errors = datasetFieldErrors(schemas[field]?.schema, values[field])
      if (errors.length) throw new Error(`${datasetFieldLabels[field]}: ${errors.join("; ")}`)
    }
    return values
  }

  edit(item: DatasetItem, draft: ItemDraft, isNew = false) {
    const entry = this.entries.get(item.id) ?? {
      item, preview: item, draft, isNew, status: "saved" as const, generation: 0,
    }
    entry.draft = draft
    entry.generation++
    entry.error = undefined
    this.entries.set(item.id, entry)
    this.schedule(entry)
  }

  private schedule(entry: Entry) {
    clearTimeout(entry.timer)
    entry.timer = undefined
    try {
      const values = this.parse(entry)
      entry.preview = { ...entry.item, ...values }
      const changed = entry.isNew || canonicalJson(values) !== canonicalJson(valuesOf(entry.item))
      entry.status = entry.inFlight ? "saving" : changed ? "pending" : "saved"
      if (changed && !entry.inFlight) entry.timer = setTimeout(() => {
        entry.timer = undefined
        void this.persist(entry)
      }, this.options.delay ?? 650)
    } catch (error) {
      entry.status = "invalid"
      entry.error = (error as Error).message
    }
    this.emit(entry)
  }

  private persist(entry: Entry): Promise<void> {
    if (entry.inFlight) return entry.inFlight
    if (entry.removed || entry.status === "saved") return Promise.resolve()
    clearTimeout(entry.timer)
    entry.timer = undefined
    let values: ItemValues
    try { values = this.parse(entry) } catch {
      this.schedule(entry)
      return Promise.resolve()
    }
    const generation = entry.generation
    const wasNew = entry.isNew
    entry.status = "saving"
    entry.error = undefined
    // Start in a microtask so inFlight is set before any callback can queue edits.
    entry.inFlight = Promise.resolve().then(async () => {
      try {
        const saved = await this.options.save(entry.item, values, wasNew)
        entry.item = saved
        entry.isNew = false
        entry.preview = saved
        entry.status = "saved"
        if (!this.detached && !entry.removed) this.options.saved(saved, wasNew)
      } catch (error) {
        entry.preview = entry.item
        entry.status = "error"
        entry.error = (error as Error).message
      } finally {
        entry.inFlight = undefined
        // A failure keeps the latest draft for retry; it never spins in a retry loop.
        if (entry.status !== "error" && generation !== entry.generation && !entry.removed) {
          this.schedule(entry)
          if (this.detached && entry.status === "pending") void this.persist(entry)
        } else this.emit(entry)
      }
    })
    this.emit(entry)
    return entry.inFlight
  }

  retry(id: string) {
    const entry = this.entries.get(id)
    if (entry) return this.persist(entry)
    return Promise.resolve()
  }

  async flush(id?: string) {
    await Promise.all([...this.entries.values()].filter(entry => !id || entry.item.id === id).map(async entry => {
      if (entry.status === "error" || entry.status === "invalid") return
      await this.persist(entry)
      if (entry.status === "pending") await this.persist(entry)
    }))
  }

  async remove(id: string) {
    const entry = this.entries.get(id)
    if (!entry) return
    entry.removed = true
    clearTimeout(entry.timer)
    await entry.inFlight
    this.entries.delete(id)
    return { item: entry.item, isNew: entry.isNew }
  }

  get hasUnsavedChanges() {
    return [...this.entries.values()].some(entry => !entry.removed && entry.status !== "saved")
  }

  detach() {
    void this.flush()
    this.detached = true
  }

  attach() { this.detached = false }

  configure(options: Pick<DatasetAutosave["options"], "schemas" | "saved">) {
    this.options = { ...this.options, ...options }
  }
}
