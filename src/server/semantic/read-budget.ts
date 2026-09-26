import { AsyncLocalStorage } from "node:async_hooks"
/** Process-wide admission prevents the pool's pending queue growing with traffic. */
export class ReadBudgetError extends Error {
  constructor(
    readonly code: "READ_BUSY" | "READ_TIMEOUT" | "READ_RESULT_TOO_LARGE",
    message: string
  ) {
    super(message)
    this.name = "ReadBudgetError"
  }
}
export type ReadLane = "interactive" | "analytics"
type Waiting = { project: string; lane: ReadLane; grant: () => void }
type Admission = {
  active: Record<ReadLane, number>
  projects: Map<string, number>
  waiting: Waiting[]
}
const state = globalThis as typeof globalThis & {
  datoolReadAdmissionV2?: Admission
}
const admissionState = (): Admission =>
  (state.datoolReadAdmissionV2 ??= {
    active: { interactive: 0, analytics: 0 },
    projects: new Map(),
    waiting: [],
  })
const projectKey = (project: string, lane: ReadLane) => `${lane}:${project}`
const available = (state: Admission, project: string, lane: ReadLane) =>
  state.active[lane] < (lane === "interactive" ? 4 : 2) &&
  (state.projects.get(projectKey(project, lane)) ?? 0) < 2
/** Four collection slots and two analytical slots share the six-connection ceiling. */
export function acquireRead(project: string, lane: ReadLane = "interactive") {
  const admission = admissionState(),
    key = projectKey(project, lane)
  if (!available(admission, project, lane))
    throw new ReadBudgetError(
      "READ_BUSY",
      "The read lane is busy. Retry shortly."
    )
  admission.active[lane]++
  admission.projects.set(key, (admission.projects.get(key) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    admission.active[lane]--
    const remaining = (admission.projects.get(key) ?? 1) - 1
    if (remaining) admission.projects.set(key, remaining)
    else admission.projects.delete(key)
    for (const entry of [...admission.waiting]) {
      if (available(admission, entry.project, entry.lane)) entry.grant()
    }
  }
}
/** At most 32 globally / 8 per project wait for up to two seconds. */
export function acquireReadAsync(
  project: string,
  waitMs = 2000,
  lane: ReadLane = "interactive"
): Promise<() => void> {
  try {
    return Promise.resolve(acquireRead(project, lane))
  } catch (error) {
    if (!(error instanceof ReadBudgetError)) return Promise.reject(error)
  }
  const admission = admissionState()
  const waiting = (admission.waiting ??= [])
  if (
    waiting.filter((entry) => entry.lane === lane).length >= 16 ||
    waiting.filter((entry) => entry.project === project && entry.lane === lane)
      .length >= 8
  ) {
    return Promise.reject(
      new ReadBudgetError("READ_BUSY", "The read queue is full. Retry shortly.")
    )
  }
  return new Promise((resolve, reject) => {
    const remove = () => {
      const index = waiting.indexOf(entry)
      if (index >= 0) waiting.splice(index, 1)
    }
    const timer = setTimeout(
      () => {
        remove()
        reject(
          new ReadBudgetError(
            "READ_BUSY",
            "The read queue wait expired. Retry shortly."
          )
        )
      },
      Math.min(2000, Math.max(0, waitMs))
    )
    const entry: Waiting = {
      project,
      lane,
      grant: () => {
        remove()
        clearTimeout(timer)
        resolve(acquireRead(project, lane))
      },
    }
    waiting.push(entry)
  })
}
export const READ_BATCH_DEADLINE_MS = 15_000
export const READ_MAX_BYTES = 8 * 1024 * 1024

/** Nested helpers share one admission slot for the authorized project. */
const readContext = new AsyncLocalStorage<ReadonlySet<string>>()
export async function withReadBudget<T>(
  project: string,
  work: () => Promise<T>
): Promise<T> {
  const current = readContext.getStore()
  if (current?.has(project)) return work()
  const release = await acquireReadAsync(project)
  try {
    return await readContext.run(new Set([...(current ?? []), project]), work)
  } finally {
    release()
  }
}
