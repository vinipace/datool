import type { DiagnosticReport } from "../../../../src/lib/inbox/diagnostics"

type Storage = { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> }

/** Small, separate queue: reporting never shares or blocks the customer outbox. */
export class DiagnosticQueue {
  private tail: Promise<unknown> = Promise.resolve()
  private draining: Promise<void> | undefined
  constructor(private storage: Storage, private key: string) {}
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work)
    this.tail = result.catch(() => {})
    return result
  }
  private async read(): Promise<DiagnosticReport[]> {
    const raw = await this.storage.getItem(this.key)
    let reports: DiagnosticReport[]
    try { reports = raw ? JSON.parse(raw) : [] } catch { reports = [] }
    if (!Array.isArray(reports)) reports = []
    return reports.filter(report => Date.now() - Date.parse(report.occurredAt) < 7 * 86400_000).slice(-30)
  }
  add(report: DiagnosticReport) {
    return this.serial(async () => {
      const reports = await this.read()
      // Suppress the same recurring error for one minute, including on restart.
      if (reports.some(item => item.stage === report.stage && item.code === report.code && item.httpStatus === report.httpStatus && Date.parse(report.occurredAt) - Date.parse(item.occurredAt) < 60_000)) return
      await this.storage.setItem(this.key, JSON.stringify([...reports, report].slice(-30)))
    })
  }
  flush(send: (report: DiagnosticReport) => Promise<"saved" | "discard" | "retry">) {
    if (this.draining) return this.draining
    this.draining = (async () => {
      for (;;) {
        const report = await this.serial(async () => (await this.read())[0])
        if (!report || await send(report) === "retry") return
        await this.serial(async () => {
          const reports = await this.read()
          await this.storage.setItem(this.key, JSON.stringify(reports.filter(item => item.id !== report.id)))
        })
      }
    })().finally(() => { this.draining = undefined })
    return this.draining
  }
}
