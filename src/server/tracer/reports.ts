import type { DashboardWidget } from "@/src/lib/tracer/dashboards"
import {
  compileReportDocument,
  validateMdxEvidence,
  ReportMdxError,
  type ReportDiagnostic,
  type ReportDocumentInput,
} from "@/src/lib/tracer/report-mdx"
import { presentDashboardResult } from "@/src/lib/tracer/dashboard-presentation"
import { resolveReportEvidence } from "@/src/lib/tracer/report-evidence"
import { createHash, randomBytes } from "node:crypto"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  reportInputSchema,
  reportUpdateSchema,
  reportValidationSchema,
  type ReportCaptureInput,
  reportPublishSchema,
  reportShareSchema,
  reportCloneSchema,
  type ReportInput,
  type Report,
  type ReportSnapshot,
  type ReportSummary,
  type ReportAuthor,
} from "@/src/lib/tracer/reports"
import { dashboardQueryPlan } from "@/src/lib/tracer/dashboard-query-plan"
import { semanticCatalog } from "@/src/server/metrics/registry"
import { executeSemanticBatch } from "@/src/server/semantic/executor"
import { createSemanticSnapshotRunner } from "@/src/server/semantic/snapshot"
import {
  semanticErrorToTracerError,
  toSemanticServiceError,
} from "@/src/server/semantic/errors"
import { READ_MAX_BYTES } from "@/src/server/semantic/read-budget"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import { reports } from "./schema"
import { readCatalog, CATALOG_LIMIT } from "./catalog-read"
import { matchesReportHighlight } from "@/src/lib/tracer/report-highlights"
import { reportLayoutSchema } from "@/src/lib/tracer/report-layout-contract"
import { workspaceIdentity } from "@/src/server/auth/context"
import { renderReportForValidation } from "./report-render-validation"

const cohortResultFields = ["result", "summary", "previous", "history"] as const

function captureQuery(
  query: DashboardWidget["query"]
): DashboardWidget["query"] {
  return { ...query, offset: 0, limit: 5000, total: true }
}

function remapCapturePositions(
  positions: ReportSnapshot["positions"],
  indexes: number[]
): void {
  for (const position of positions)
    for (const cohort of position.cohorts)
      for (const field of cohortResultFields) {
        const index = cohort[field]
        if (index !== null) cohort[field] = indexes[index]
      }
}

function reportDiagnostics(error: unknown): ReportDiagnostic[] {
  if (error instanceof ReportMdxError) return error.diagnostics
  if (error instanceof TracerError && error.details?.diagnostics)
    return error.details.diagnostics as ReportDiagnostic[]
  return [
    {
      severity: "error",
      message: error instanceof Error ? error.message : "Invalid report",
      line: 1,
      column: 1,
    },
  ]
}

const summaryColumns = {
  id: reports.id,
  number: reports.number,
  name: reports.name,
  description: reports.description,
  templateId: reports.templateId,
  widgetCount: reports.widgetCount,
  createdAt: reports.createdAt,
  frozenAt: reports.frozenAt,
  status: reports.status,
  revision: reports.revision,
  updatedAt: reports.updatedAt,
  publishedAt: reports.publishedAt,
  author: reports.author,
}
export function decodeReport(row: typeof reports.$inferSelect): Report {
  return {
    id: row.id,
    number: row.number,
    name: row.name,
    description: row.description,
    templateId: row.templateId,
    widgetCount: row.widgetCount,
    createdAt: row.createdAt,
    frozenAt: row.frozenAt,
    author: row.author,
    status: row.status as "draft" | "published",
    revision: row.revision,
    updatedAt: row.updatedAt ?? row.createdAt,
    publishedAt: row.publishedAt,
    publicPath: row.publicToken ? `/share/reports/${row.publicToken}` : null,
    publicUrl:
      row.publicToken && process.env.BETTER_AUTH_URL
        ? new URL(
            `/share/reports/${row.publicToken}`,
            process.env.BETTER_AUTH_URL
          ).href
        : null,
    ...(row.mdxJson
      ? {
          mdx: JSON.parse(row.mdxJson),
          document: (({ creationKey: _key, ...document }) => {
            void _key
            return document
          })(authoringInput(row)),
          ...(row.status === "draft"
            ? { draftInput: authoringInput(row) }
            : {}),
        }
      : {}),
    // Frozen definitions and annotations do not depend on today's metric catalog.
    config: JSON.parse(row.configJson),
    snapshot: JSON.parse(row.snapshotJson),
    presentation: row.presentationJson
      ? JSON.parse(row.presentationJson)
      : null,
    presentationRevision: row.presentationRevision,
    layout: reportLayoutSchema.parse(row.layout),
  }
}

function authoringInput(row: typeof reports.$inferSelect): ReportInput {
  if (!row.mdxJson || !row.inputJson)
    throw validation(
      "This report predates MDX. Create an MDX report from its captured evidence."
    )
  return JSON.parse(row.inputJson)
}

function checkSize(
  configJson: string,
  snapshotJson: string,
  presentation: unknown,
  inputJson = ""
) {
  if (
    Buffer.byteLength(configJson) +
      Buffer.byteLength(snapshotJson) +
      Buffer.byteLength(JSON.stringify(presentation)) +
      Buffer.byteLength(inputJson) >
    READ_MAX_BYTES - 4096
  )
    throw validation("This report exceeds 8 MiB. Narrow its scope.")
}
function validateCaptureConfig(
  input: Pick<ReportCaptureInput, "config" | "highlights" | "references">
) {
  for (const highlight of input.highlights ?? []) {
    const widget = input.config.widgets.find(
      (widget) => widget.id === highlight.widgetId
    )
    if (
      !widget ||
      widget.type === "text" ||
      !["matrix", "bar", "line", "scatter"].includes(widget.type) ||
      (highlight.measure !== undefined &&
        !(widget.series ?? widget.query.measures).includes(
          highlight.measure
        )) ||
      widget.groups?.length ||
      Object.keys(highlight.dimensions).some(
        (field) =>
          ![
            ...widget.query.dimensions,
            ...widget.query.timeDimensions
              .filter((t) => t.granularity)
              .map((t) => t.dimension),
          ].includes(field)
      )
    )
      throw validation(
        "Highlights require a matrix, bar, line or scatter widget without cohorts and selected dimension fields."
      )
  }
  for (const reference of input.references ?? []) {
    const widget = input.config.widgets.find((w) => w.id === reference.widgetId)
    if (
      !widget ||
      widget.type === "text" ||
      !["bar", "line", "scatter"].includes(widget.type) ||
      widget.groups?.length ||
      !(widget.series ?? widget.query.measures).includes(reference.measure)
    )
      throw validation(
        "Reference thresholds require a selected measure in a bar, line or scatter chart without cohorts."
      )
  }
}
function validateCaptureData(
  input: Pick<ReportCaptureInput, "config" | "highlights" | "references">,
  snapshot: ReportSnapshot
) {
  for (const reference of input.references ?? []) {
    const widget = input.config.widgets.find(
      (w) => w.id === reference.widgetId
    )!
    const position = snapshot.positions.find(
      (p) => p.id === reference.widgetId
    )!
    const result = snapshot.results[position.cohorts[0].result]
    if (
      widget.type === "line" &&
      new Set(
        (widget.series ?? widget.query.measures).map(
          (m) => result.annotation.measures[m]?.unit
        )
      ).size > 1
    )
      throw validation(
        "Line reference thresholds require series with the same unit."
      )
  }
  for (const highlight of input.highlights ?? []) {
    const position = snapshot.positions.find(
      (position) => position.id === highlight.widgetId
    )!
    if (
      !position.cohorts.some((cohort) =>
        snapshot.results[cohort.result].data.some(
          (row) =>
            matchesReportHighlight(highlight, row) &&
            typeof row[
              highlight.measure ??
                snapshot.results[cohort.result].query.measures[0]
            ] === "number"
        )
      )
    )
      throw validation(
        `Highlight "${highlight.label}" does not match captured data.`
      )
  }
  for (const widget of input.config.widgets) {
    if (widget.type === "text" || !widget.presentation) continue
    const position = snapshot.positions.find((p) => p.id === widget.id)!
    try {
      presentDashboardResult(
        snapshot.results[position.cohorts[0].result],
        widget.presentation
      )
    } catch (error) {
      throw validation(
        error instanceof Error ? error.message : "Invalid presentation."
      )
    }
  }
}
async function captureReport(
  input: ReportCaptureInput,
  database: TracerDatabase
) {
  validateCaptureConfig(input)
  const plan = dashboardQueryPlan(input.config.widgets, {})
  const queries: DashboardWidget["query"][] = []
  const indexes = new Map<string, number>()
  const remap = plan.batches.flat().map((query) => {
    const full = captureQuery(query)
    const key = JSON.stringify(full)
    if (!indexes.has(key)) {
      indexes.set(key, queries.length)
      queries.push(full)
    }
    return indexes.get(key)!
  })
  remapCapturePositions(plan.positions, remap)
  if (queries.length > 40)
    throw validation(
      "This report needs more than 40 queries. Remove widgets or comparison cohorts before generating."
    )
  // Capture complete grouped results in one database snapshot. UI page sizes
  // are presentation only; refusing oversized data avoids frozen partial reports.
  const snapshot: ReportSnapshot = {
    schemaVersion: 1,
    ...(input.references?.length ? { references: input.references } : {}),
    positions: plan.positions,
    results: [],
    ...(input.highlights?.length ? { highlights: input.highlights } : {}),
  }
  try {
    snapshot.results = queries.length
      ? await executeSemanticBatch(
          { queries },
          {
            catalog: semanticCatalog,
            snapshotRunner: createSemanticSnapshotRunner(database),
            requestId: `report_${crypto.randomUUID()}`,
            now: () => new Date(),
          }
        )
      : []
  } catch (error) {
    throw semanticErrorToTracerError(toSemanticServiceError(error))
  }
  if (
    snapshot.results.some(
      (result) =>
        result.meta.page.total === undefined ||
        result.meta.page.total > result.data.length
    )
  )
    throw validation(
      "A report widget exceeds 5,000 rows. Narrow its filters or date range before generating."
    )
  validateCaptureData(input, snapshot)
  let resolved
  try {
    resolved = resolveReportEvidence(input.config, snapshot, input.bindings)
  } catch (error) {
    throw validation(
      error instanceof Error ? error.message : "Invalid evidence binding."
    )
  }
  if (resolved.evidence.values.length) snapshot.evidence = resolved.evidence
  const layout = "document"
  const presentation = null
  const snapshotJson = JSON.stringify(snapshot)
  const configJson = JSON.stringify(resolved.config)
  if (
    Buffer.byteLength(snapshotJson) +
      Buffer.byteLength(configJson) +
      Buffer.byteLength(JSON.stringify(presentation)) +
      Buffer.byteLength(JSON.stringify(input)) >
    READ_MAX_BYTES - 4096
  )
    throw validation(
      "This report exceeds 8 MiB. Narrow its filters or remove widgets before generating."
    )

  return { configJson, snapshotJson, snapshot, presentation, layout }
}

function reuseReportCapture(
  document: ReportDocumentInput,
  built: ReturnType<typeof compileReportDocument>,
  previous: typeof reports.$inferSelect
) {
  const old = authoringInput(previous)
  const queryShape = (sources: ReportDocumentInput["sources"]) =>
    JSON.stringify(
      Object.entries(sources)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, s]) => [name, s.query])
    )
  if (queryShape(old.sources) !== queryShape(document.sources))
    throw validation(
      "Queries changed. Refresh the captured data before saving this revision."
    )
  const priorConfig = JSON.parse(
    previous.configJson
  ) as ReportCaptureInput["config"]
  const priorSnapshot = JSON.parse(previous.snapshotJson) as ReportSnapshot
  const plan = dashboardQueryPlan(built.config.widgets, {})
  const priorPlan = dashboardQueryPlan(priorConfig.widgets, {})
  const key = (query: DashboardWidget["query"]) =>
    JSON.stringify(captureQuery(query))
  const priorQueries = priorPlan.batches.flat()
  const results = new Map<string, number>()
  for (const position of priorPlan.positions) {
    const stored = priorSnapshot.positions.find((p) => p.id === position.id)!
    for (const [i, cohort] of position.cohorts.entries())
      for (const field of cohortResultFields) {
        const index = cohort[field]
        const capturedIndex = stored?.cohorts[i]?.[field]
        if (index !== null && capturedIndex != null)
          results.set(key(priorQueries[index]), capturedIndex)
      }
  }
  const remap = plan.batches.flat().map((q) => {
    const found = results.get(key(q))
    if (found === undefined)
      throw validation(
        "This component needs additional data. Refresh the capture before saving."
      )
    return found
  })
  remapCapturePositions(plan.positions, remap)
  const snapshot: ReportSnapshot = {
    ...priorSnapshot,
    positions: plan.positions,
    references: built.references,
    highlights: built.highlights,
  }
  validateCaptureData(built, snapshot)
  const resolved = resolveReportEvidence(built.config, snapshot, built.bindings)
  snapshot.evidence = resolved.evidence
  for (const widget of built.config.widgets)
    if (widget.type !== "text")
      presentDashboardResult(
        snapshot.results[
          snapshot.positions.find((p) => p.id === widget.id)!.cohorts[0].result
        ],
        widget.presentation
      )
  return {
    configJson: JSON.stringify(resolved.config),
    snapshotJson: JSON.stringify(snapshot),
    snapshot,
    presentation: null,
    layout: "document",
  }
}

async function prepareMdxUnchecked(
  document: ReportDocumentInput,
  database: TracerDatabase,
  previous?: typeof reports.$inferSelect,
  refresh = false
) {
  const built = compileReportDocument(document)
  validateCaptureConfig(built)
  const captured =
    !previous || refresh
      ? await captureReport(
          { ...built, templateId: "mdx", creationKey: crypto.randomUUID() },
          database
        )
      : reuseReportCapture(document, built, previous)
  validateMdxEvidence(built.compiled, {
    config: JSON.parse(captured.configJson),
    snapshot: captured.snapshot,
  })
  const mdxJson = JSON.stringify(built.compiled)
  const renderCheck = await renderReportForValidation({
    id: previous?.id ?? "report-validation",
    number: previous?.number ?? 1,
    name: document.name,
    description: document.description,
    templateId: "mdx",
    widgetCount: built.componentCount,
    createdAt: previous?.createdAt ?? new Date().toISOString(),
    frozenAt:
      previous?.frozenAt ??
      captured.snapshot.results[0]?.meta.asOf ??
      new Date().toISOString(),
    status: previous?.status ?? "draft",
    revision: previous?.revision ?? 1,
    updatedAt: previous?.updatedAt ?? new Date().toISOString(),
    publishedAt: previous?.publishedAt ?? null,
    config: JSON.parse(captured.configJson),
    snapshot: captured.snapshot,
    mdx: built.compiled,
  })
  if (renderCheck.status === "failed")
    throw validation(
      `The report renderer failed during validation: ${renderCheck.message ?? "Unknown renderer error."}`,
      {
        diagnostics: [
          {
            severity: "error",
            message: renderCheck.message ?? "Unknown renderer error.",
            line: 1,
            column: 1,
            path: "render",
          },
        ],
        render: renderCheck,
      }
    )
  checkSize(
    captured.configJson,
    captured.snapshotJson,
    built.compiled,
    JSON.stringify(document)
  )
  return {
    ...captured,
    mdxJson,
    warnings: built.warnings,
    widgetCount: built.componentCount,
    render: renderCheck,
  }
}

async function prepareMdx(...args: Parameters<typeof prepareMdxUnchecked>) {
  try {
    return await prepareMdxUnchecked(...args)
  } catch (error) {
    if (error instanceof TracerError) throw error
    throw validation(
      error instanceof Error ? error.message : "Invalid MDX report.",
      error instanceof ReportMdxError
        ? { diagnostics: error.diagnostics }
        : undefined
    )
  }
}

export function createReportService(database: TracerDatabase) {
  const project = getTracerProjectId(database)
  async function currentAuthor(): Promise<ReportAuthor | null> {
    const identity = workspaceIdentity()
    if (!identity) return null
    if (identity.projectId !== project)
      throw new TracerError("UNAUTHORIZED", "Project identity does not match.")
    if (identity.kind === "api-key") {
      return identity.apiKeyId
        ? {
            id: identity.apiKeyId,
            name: identity.apiKeyName || "API key",
            kind: "api-key",
          }
        : null
    }
    if (!identity.userId) return null
    const user = await database.execute<{ name: string }>(
      sql`select name from "user" where id=${identity.userId}`
    )
    return {
      id: identity.userId,
      name: user.rows[0]?.name || "Unknown user",
      kind: identity.kind,
    }
  }
  const read = async (number: number) => {
    const [row] = await database
      .select()
      .from(reports)
      .where(and(eq(reports.projectId, project), eq(reports.number, number)))
    if (!row) throw notFound("Report", String(number))
    return row
  }
  const checkRevision = (
    row: typeof reports.$inferSelect,
    revision: number
  ) => {
    if (row.revision !== revision)
      throw new TracerError(
        "CONFLICT",
        "This report changed. Reload it before continuing."
      )
  }
  const write = async (
    row: typeof reports.$inferSelect,
    changes: Partial<typeof reports.$inferInsert>
  ) => {
    const [saved] = await database
      .update(reports)
      .set({
        ...changes,
        revision: row.revision + 1,
        updatedAt: new Date().toISOString(),
      })
      .where(
        and(
          eq(reports.projectId, project),
          eq(reports.id, row.id),
          eq(reports.revision, row.revision)
        )
      )
      .returning()
    if (!saved)
      throw new TracerError(
        "CONFLICT",
        "This report changed. Reload it before continuing."
      )
    return decodeReport(saved)
  }
  return {
    validate: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportValidationSchema.safeParse(value)
        if (!parsed.success)
          return {
            valid: false,
            diagnostics: parsed.error.issues.map((issue) => ({
              severity: "error" as const,
              message: issue.message,
              line: 1,
              column: 1,
              path: issue.path.join("."),
            })),
          }
        try {
          const input = parsed.data
          const row = input.number ? await read(input.number) : undefined
          if (row && input.revision !== undefined)
            checkRevision(row, input.revision)
          const next = await prepareMdx(
            input.document,
            database,
            row,
            input.refresh
          )
          return {
            valid: true,
            diagnostics: next.warnings,
            sourceCount: Object.keys(input.document.sources).length,
            queryCount: next.snapshot.results.length,
            checks: {
              structural: "passed",
              data: "passed",
              render: next.render.status,
              visual: "not-run",
              responsive: "not-run",
            },
            render: next.render,
          }
        } catch (e) {
          if (
            e instanceof TracerError &&
            ["NOT_FOUND", "UNAUTHORIZED", "CONFLICT"].includes(e.code)
          )
            throw e
          return {
            valid: false,
            diagnostics: reportDiagnostics(e),
          }
        }
      }),
    update: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportUpdateSchema.safeParse(value)
        if (!parsed.success)
          throw validation(
            parsed.error.issues[0]?.message ?? "Invalid draft change."
          )
        const input = parsed.data
        const row = await read(input.number)
        if (row.status !== "draft")
          throw new TracerError(
            "CONFLICT",
            "Published reports cannot be edited. Create a draft copy."
          )
        checkRevision(row, input.revision)
        const authored = { ...input.document, creationKey: row.creationKey }
        const next = await prepareMdx(
          input.document,
          database,
          row,
          input.refresh
        )
        const changes: Partial<typeof reports.$inferInsert> = {
          configJson: next.configJson,
          snapshotJson: next.snapshotJson,
          mdxJson: next.mdxJson,
          inputJson: JSON.stringify(authored),
          name: authored.name,
          description: authored.description,
          widgetCount: next.widgetCount,
          presentationJson: null,
          layout: "document",
          ...(input.refresh
            ? {
                frozenAt:
                  next.snapshot.results[0]?.meta.asOf ??
                  new Date().toISOString(),
              }
            : {}),
        }
        return write(row, changes)
      }),
    publish: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportPublishSchema.safeParse(value)
        if (!parsed.success)
          throw validation("A report number and current revision are required.")
        const row = await read(parsed.data.number)
        checkRevision(row, parsed.data.revision)
        if (row.status === "published") return decodeReport(row)
        await prepareMdx(authoringInput(row), database, row)
        // Publish exactly what was reviewed, without querying live data again.
        return write(row, {
          status: "published",
          publishedAt: new Date().toISOString(),
        })
      }),
    share: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportShareSchema.safeParse(value)
        if (!parsed.success)
          throw validation(
            "A report number, current revision and enabled flag are required."
          )
        const row = await read(parsed.data.number)
        checkRevision(row, parsed.data.revision)
        if (row.status !== "published")
          throw new TracerError(
            "CONFLICT",
            "Publish the reviewed report before enabling a public link."
          )
        if (Boolean(row.publicToken) === parsed.data.enabled)
          return decodeReport(row)
        return write(row, {
          publicToken: parsed.data.enabled
            ? randomBytes(32).toString("hex")
            : null,
        })
      }),
    clone: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportCloneSchema.safeParse(value)
        if (!parsed.success)
          throw validation("A report number and UUID creationKey are required.")
        const input = parsed.data
        return database.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`report:${project}:${input.creationKey}`},0))`
          )
          const hash = createHash("sha256")
            .update(`clone:${input.number}`)
            .digest("hex")
          const [existing] = await tx
            .select()
            .from(reports)
            .where(
              and(
                eq(reports.projectId, project),
                eq(reports.creationKey, input.creationKey)
              )
            )
          if (existing) {
            if (existing.inputHash !== hash)
              throw new TracerError(
                "CONFLICT",
                "This creation key is already used."
              )
            return decodeReport(existing)
          }
          const row = await read(input.number)
          const counter = await tx.execute<{ last_number: number }>(
            sql`insert into report_counters(project_id,last_number) values(${project},1) on conflict(project_id) do update set last_number=report_counters.last_number+1 returning last_number`
          )
          const authored = authoringInput(row)
          authored.creationKey = input.creationKey
          const now = new Date().toISOString()
          const [copy] = await tx
            .insert(reports)
            .values({
              ...row,
              author: await currentAuthor(),
              id: `report_${crypto.randomUUID()}`,
              number: counter.rows[0].last_number,
              status: "draft",
              revision: 1,
              createdAt: now,
              updatedAt: now,
              publishedAt: null,
              publicToken: null,
              inputJson: JSON.stringify(authored),
              inputHash: hash,
              creationKey: input.creationKey,
            })
            .returning()
          return decodeReport(copy)
        })
      }),
    list: () =>
      tracerEffect(() =>
        readCatalog<ReportSummary>(
          database,
          sql`select id,number,name,description,template_id,widget_count,created_at,frozen_at,status,revision,updated_at,published_at,author from reports where project_id=${project}`,
          (db) =>
            db
              .select(summaryColumns)
              .from(reports)
              .where(eq(reports.projectId, project))
              .orderBy(desc(reports.createdAt), desc(reports.id))
              .limit(CATALOG_LIMIT + 1)
        )
      ),
    get: (number: number) =>
      tracerEffect(async () => {
        if (!Number.isSafeInteger(number) || number < 1)
          throw validation("A positive report number is required.")
        return decodeReport(await read(number))
      }),
    create: (value: unknown) =>
      tracerEffect(async () => {
        const parsed = reportInputSchema.safeParse(value)
        if (!parsed.success)
          throw validation(parsed.error.issues[0]?.message ?? "Invalid report.")
        const input = parsed.data
        const hash = createHash("sha256")
          .update(JSON.stringify(input))
          .digest("hex")
        const existing = async (db: Pick<TracerDatabase, "select">) => {
          const [row] = await db
            .select()
            .from(reports)
            .where(
              and(
                eq(reports.projectId, project),
                eq(reports.creationKey, input.creationKey)
              )
            )
          if (row && row.inputHash !== hash)
            throw new TracerError(
              "CONFLICT",
              "This generation key already belongs to another report configuration."
            )
          return row ? decodeReport(row) : null
        }
        const prior = await existing(database)
        if (prior) return prior
        const {
          configJson,
          snapshotJson,
          snapshot,
          presentation,
          layout,
          mdxJson,
          widgetCount,
        } = await prepareMdx(input, database)
        return database.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${`report:${project}:${input.creationKey}`},0))`
          )
          const previous = await existing(tx)
          if (previous) return previous
          const counter = await tx.execute<{
            last_number: number
          }>(sql`insert into report_counters(project_id,last_number) values(${project},1)
          on conflict(project_id) do update set last_number=report_counters.last_number+1 returning last_number`)
          const [row] = await tx
            .insert(reports)
            .values({
              projectId: project,
              author: await currentAuthor(),
              id: `report_${crypto.randomUUID()}`,
              number: counter.rows[0].last_number,
              name: input.name,
              description: input.description,
              templateId: "mdx",
              widgetCount,
              mdxJson,
              configJson,
              snapshotJson,
              layout,
              presentationJson: presentation
                ? JSON.stringify(presentation)
                : null,
              status: "draft",
              revision: 1,
              inputJson: JSON.stringify(input),
              updatedAt: new Date().toISOString(),
              creationKey: input.creationKey,
              inputHash: hash,
              createdAt: new Date().toISOString(),
              frozenAt:
                snapshot.results[0]?.meta.asOf ?? new Date().toISOString(),
            })
            .returning()
          return decodeReport(row)
        })
      }),
  }
}
