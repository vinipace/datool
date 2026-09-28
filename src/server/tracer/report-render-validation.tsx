import { spawn } from "node:child_process"
import { join } from "node:path"
import type { Report } from "@/src/lib/tracer/reports"
import type { CompiledReportMdx } from "@/src/lib/tracer/report-mdx"

export type ReportRenderCheck = {
  scope: "render"
  status: "passed" | "failed"
  renderer: "react-dom/server"
  markupBytes?: number
  nodeCount?: number
  expandedDisclosureCheck?: boolean
  message?: string
  visualReviewRequired: true
  responsiveReviewRequired: true
}

/**
 * Invoke the same report document component used by the browser.
 *
 * A Bun subprocess keeps React's normal SSR module graph separate from Next's
 * React Server Component graph. Bun and the source modules are also shipped in
 * the application runtime image. Only the validated AST and captured evidence
 * are sent to the worker; authored JavaScript is never executed.
 *
 * This is deliberately a smoke check rather than a screenshot assertion. It
 * catches component/runtime exceptions and malformed frozen data before a
 * report is persisted, while leaving typography, CSS, chart readability and
 * responsive review to the browser workflow.
 */
export async function renderReportForValidation(
  report: Report & { mdx: CompiledReportMdx }
): Promise<ReportRenderCheck> {
  return new Promise((resolve) => {
    const worker = join(
      process.cwd(),
      "src/server/tracer/report-render-worker.tsx"
    )
    const child = spawn("bun", [worker], {
      stdio: ["pipe", "pipe", "ignore"],
      env: process.env,
    })
    const chunks: Buffer[] = []
    let settled = false
    const finish = (check: ReportRenderCheck) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(check)
    }
    const timeout = setTimeout(() => {
      child.kill("SIGTERM")
      finish({
        scope: "render",
        status: "failed",
        renderer: "react-dom/server",
        message: "The renderer smoke check timed out after 10 seconds.",
        visualReviewRequired: true,
        responsiveReviewRequired: true,
      })
    }, 10_000)
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk))
    child.on("error", (error) =>
      finish({
        scope: "render",
        status: "failed",
        renderer: "react-dom/server",
        message: error.message,
        visualReviewRequired: true,
        responsiveReviewRequired: true,
      })
    )
    child.stdin.on("error", (error) => {
      child.kill("SIGTERM")
      finish({
        scope: "render",
        status: "failed",
        renderer: "react-dom/server",
        message: `Unable to send captured evidence to the renderer: ${error.message}`,
        visualReviewRequired: true,
        responsiveReviewRequired: true,
      })
    })
    child.on("close", (code) => {
      if (settled) return
      try {
        const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as ReportRenderCheck
        finish(result)
      } catch {
        finish({
          scope: "render",
          status: "failed",
          renderer: "react-dom/server",
          message:
            code === null
              ? "The renderer smoke check was interrupted."
              : `The renderer smoke check exited with code ${code}.`,
          visualReviewRequired: true,
          responsiveReviewRequired: true,
        })
      }
    })
    child.stdin.end(JSON.stringify(report))
  })
}
