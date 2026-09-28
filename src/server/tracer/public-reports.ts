import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { db } from "@/lib/db"
import type { TracerDatabase } from "./db"
import * as schema from "./schema"
import { decodeReport } from "./reports"
import type { Report } from "@/src/lib/tracer/reports"

/** Public access is a separate capability lookup, never a project/number lookup. */
export async function readPublicReport(
  token: string,
  database: Pick<TracerDatabase, "select"> = drizzle({ client: db, schema })
): Promise<Report | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null
  const [row] = await database
    .select()
    .from(schema.reports)
    .where(
      and(
        eq(schema.reports.publicToken, token),
        eq(schema.reports.status, "published")
      )
    )
    .limit(1)
  if (!row) return null
  const report = decodeReport(row)
  // Public readers receive the captured report, not authoring inputs or query
  // filter values (which can contain internal resource selectors).
  delete report.document
  delete report.draftInput
  delete report.publicPath
  delete report.publicUrl
  // Workspace attribution is not part of the publicly shared report content.
  delete report.author
  for (const widget of report.config.widgets) {
    if (widget.type === "text") continue
    widget.query.filters = []
    delete widget.query.classification
    delete widget.query.comparison
    delete widget.groups
    delete widget.compare
  }
  for (const result of report.snapshot.results) {
    result.query.filters = []
    delete result.query.classification
    delete result.query.comparison
    result.meta.requestId = "public-report"
  }
  if (report.snapshot.evidence) {
    report.snapshot.evidence.templates = {}
    for (const value of report.snapshot.evidence.values) {
      value.binding.source.dimensions = {}
      if (value.binding.baseline) value.binding.baseline.dimensions = {}
    }
  }
  return report
}
