import {
  reportDocumentSchema,
  type ReportDocumentInput,
  type CompiledReportMdx,
} from "./report-mdx"
import {
  reportBindingSchema,
  type ResolvedReportEvidence,
} from "./report-evidence"
import { z } from "zod"
import type { ReportPresentation } from "./report-presentation"
import { reportPresentationSchema } from "./report-presentation"
import type { ReportLayout } from "./report-layout-contract"
import { dashboardInputSchema } from "./dashboards"
import type { SemanticResult } from "@/src/lib/semantic/result"
import { dashboardQueryPlan } from "./dashboard-query-plan"
import {
  reportReferenceSchema,
  type ReportReference,
  reportHighlightSchema,
  type ReportHighlight,
} from "./report-highlights"

export const reportCaptureSchema = z
  .object({
    config: dashboardInputSchema.refine(
      (config) => config.widgets.length > 0,
      "Add at least one widget."
    ),
    templateId: z.string().min(1).max(100),
    creationKey: z.string().uuid(),
    presentation: reportPresentationSchema.optional(),
    bindings: z.array(reportBindingSchema).max(100).optional(),
    references: z.array(reportReferenceSchema).max(20).optional(),
    highlights: z.array(reportHighlightSchema).max(40).optional(),
  })
  .strict()
export type ReportCaptureInput = z.infer<typeof reportCaptureSchema>
export const reportInputSchema = reportDocumentSchema.safeExtend({
  creationKey: z.string().uuid(),
})
export type ReportInput = z.infer<typeof reportInputSchema>
const reportVersion = {
  number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  revision: z.number().int().positive(),
}
export const reportUpdateSchema = z
  .object({
    ...reportVersion,
    document: reportDocumentSchema,
    refresh: z.boolean().default(false),
  })
  .strict()
export const reportValidationSchema = z
  .object({
    document: reportDocumentSchema,
    number: reportVersion.number.optional(),
    revision: reportVersion.revision.optional(),
    refresh: z.boolean().default(false),
  })
  .strict()
export const reportPublishSchema = z.object(reportVersion).strict()
export const reportShareSchema = z
  .object({ ...reportVersion, enabled: z.boolean() })
  .strict()
export const reportCloneSchema = z
  .object({
    number: reportVersion.number,
    creationKey: z.string().uuid(),
  })
  .strict()
export type ReportAuthor = {
  id: string
  name: string
  kind: "session" | "oauth" | "api-key"
}
export type ReportSummary = {
  id: string
  number: number
  name: string
  description: string
  templateId: string
  widgetCount: number
  createdAt: string
  frozenAt: string
  /** Captured from the authenticated creator; older reports may have no author. */
  author?: ReportAuthor | null
  /** Missing only on legacy client fixtures; stored reports always have a status. */
  status?: "draft" | "published"
  revision?: number
  updatedAt?: string | null
  publishedAt?: string | null
}
export type ReportSnapshot = {
  schemaVersion: 1
  positions: ReturnType<typeof dashboardQueryPlan>["positions"]
  results: SemanticResult[]
  evidence?: {
    templates: Record<string, string>
    values: ResolvedReportEvidence[]
  }
  references?: ReportReference[]
  highlights?: ReportHighlight[]
}
export type Report = ReportSummary & {
  document?: ReportDocumentInput
  mdx?: CompiledReportMdx

  config: ReportCaptureInput["config"]
  snapshot: ReportSnapshot
  presentation?: ReportPresentation | null
  presentationRevision?: number
  layout?: ReportLayout
  publicPath?: string | null
  publicUrl?: string | null
  draftInput?: ReportInput
}

/** All captured rows remain local when readers page through a frozen widget. */
export function frozenReportPage(
  result: SemanticResult,
  limit: number,
  offset: number
): SemanticResult {
  return {
    ...result,
    query: { ...result.query, limit, offset },
    data: result.data.slice(offset, offset + limit),
    meta: {
      ...result.meta,
      page: { limit, offset, total: result.data.length },
    },
  }
}
