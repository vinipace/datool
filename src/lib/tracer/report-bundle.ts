import { z } from "zod"
import {
  parseReportFile,
  reportDocumentSchema,
  type ReportDocumentInput,
} from "./report-mdx"

/**
 * The data half of the two-file report authoring format.
 *
 * The server still stores a single ReportDocumentInput. This schema only
 * removes the MDX body so authors can keep the narrative and the data/query
 * contract in separate, readable files.
 */
// Zod intentionally does not allow `.omit()` after a schema has refinements.
// Keep this mirror explicit so the report document's source/binding field
// schemas remain shared while its MDX body is moved into the other file.
export const reportDataFileSchema = z
  .object({
    name: reportDocumentSchema.shape.name,
    description: reportDocumentSchema.shape.description,
    sources: reportDocumentSchema.shape.sources,
    bindings: reportDocumentSchema.shape.bindings,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Object.keys(value.sources).length > 20)
      ctx.addIssue({ code: "custom", message: "Use at most 20 named sources." })
    if (Object.keys(value.bindings).length > 100)
      ctx.addIssue({
        code: "custom",
        message: "Use at most 100 evidence bindings.",
      })
  })
export type ReportDataFileInput = z.input<typeof reportDataFileSchema>

export type ReportBundleSource = "mdx" | "data"

/** Error with enough context for editors and CLIs to point at the right file. */
export class ReportBundleError extends Error {
  constructor(
    message: string,
    readonly source: ReportBundleSource,
    readonly cause?: unknown
  ) {
    super(message)
    this.name = "ReportBundleError"
  }
}

function parseDataFile(data: string): ReportDataFileInput {
  if (data.length > 1024 * 1024)
    throw new ReportBundleError("Report data file exceeds 1 MiB.", "data")
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    throw new ReportBundleError(
      "Report data must be valid JSON.",
      "data",
      error
    )
  }
  try {
    return reportDataFileSchema.parse(value)
  } catch (error) {
    throw new ReportBundleError(
      error instanceof Error ? error.message : "Invalid report data.",
      "data",
      error
    )
  }
}

/**
 * Parse the preferred paired authoring files into the server document shape.
 *
 * With no data file this intentionally falls back to the legacy one-file
 * parser. That keeps existing `report.mdx` files and stored exports usable
 * while making the paired format the default for new authoring workflows.
 */
export function parseReportBundle(
  mdx: string,
  data?: string
): ReportDocumentInput {
  if (data === undefined) {
    try {
      return parseReportFile(mdx)
    } catch (error) {
      throw new ReportBundleError(
        error instanceof Error ? error.message : "Invalid report MDX.",
        "mdx",
        error
      )
    }
  }

  const reportData = parseDataFile(data)
  // A frontmatter header in the narrative would make the same fields appear
  // in two places. Keep legacy support through the one-file path, while
  // giving paired authors a clear diagnostic instead of silently merging.
  const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(mdx)
  if (header && /^(?:name|description|sources|bindings)\s*:/m.test(header[1]))
    throw new ReportBundleError(
      "Paired report.mdx must contain only the Markdown/MDX body; move name, description, sources and bindings to report.data.json.",
      "mdx"
    )
  try {
    return reportDocumentSchema.parse({ ...reportData, mdx })
  } catch (error) {
    throw new ReportBundleError(
      error instanceof Error ? error.message : "Invalid report document.",
      error instanceof z.ZodError &&
        error.issues.every((issue) => issue.path[0] === "mdx")
        ? "mdx"
        : "data",
      error
    )
  }
}

/** Split a server document into the two files used by agents and the editor. */
export function serializeReportBundle(input: ReportDocumentInput) {
  const { mdx, ...data } = input
  return {
    mdx: `${mdx.trim()}\n`,
    data: `${JSON.stringify(data, null, 2)}\n`,
  }
}

/**
 * Format an error for the paired file currently being edited. MDX has no
 * frontmatter offset; JSON includes the parser's source position when available.
 */
export function reportBundleError(
  error: unknown,
  source: ReportBundleSource,
  text: string
) {
  const root =
    error instanceof ReportBundleError ? (error.cause ?? error) : error
  if (source === "mdx" && !(root instanceof z.ZodError))
    return root instanceof Error ? root.message : "Unable to validate report MDX."

  if (root instanceof SyntaxError) {
    const match = /position (\d+)/i.exec(root.message)
    // Bun's JSON parser omits the offset for some malformed documents. Point
    // at the end of the data in that case; it is the only precise location
    // available without evaluating the document or adding a parser runtime.
    const position = match ? Number(match[1]) : text.length
    const before = text.slice(0, position)
    const line = before.split("\n").length
    const column = position - before.lastIndexOf("\n")
    return `Line ${line}:${column}: ${root.message}`
  }
  if (root && typeof root === "object" && "issues" in root) {
    const issues = (root as { issues?: unknown }).issues
    if (Array.isArray(issues) && issues.length) {
      const messages = issues.map((issue) => {
        if (!issue || typeof issue !== "object") return String(issue)
        const path = Array.isArray((issue as { path?: unknown }).path)
          ? (issue as { path: unknown[] }).path.join(".") || "document"
          : "document"
        return `${path}: ${String((issue as { message?: unknown }).message ?? "Invalid value.")}`
      })
      return messages.join("\n")
    }
  }
  return root instanceof Error
    ? root.message
    : "Unable to validate report data."
}
