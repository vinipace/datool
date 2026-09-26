import { evalComparisonUrl } from "@/src/lib/tracer/eval-comparison"
import { redirect } from "next/navigation"

// Keep old comparison links working while rendering everything on the run page.
export default async function Page({ searchParams }: { searchParams: Promise<{ left?: string; right?: string }> }) {
  const { left, right } = await searchParams
  if (!left) redirect("/evals")
  redirect(evalComparisonUrl([left, ...(right ? [right] : [])]))
}
