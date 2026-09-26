import { readFile } from "node:fs/promises"
import { notFound } from "next/navigation"
import { pageMetadata } from "@/lib/page-metadata"
import type { TraceDetail } from "@/src/lib/tracer/contracts"
import { TraceViewDemo } from "./reference"

export const metadata = pageMetadata("uiReference")
export default async function Page() {
  if (process.env.NODE_ENV !== "development") notFound()
  const code = await readFile("examples/trace-views/evidence-diagnosis.tsx.txt", "utf8")
  let trace: TraceDetail | null = null
  try { trace = JSON.parse(await readFile("artifacts/trace-view-demo.json", "utf8")) } catch { /* Optional ignored local evidence packet. */ }
  return <TraceViewDemo code={code} trace={trace} />
}
