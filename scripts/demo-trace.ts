import { runDemoWorkflow } from "@/src/lib/tracer/demo"
import { createTracer } from "@/src/lib/tracer/sdk"

const baseUrl = process.env.DATOOL_TRACE_BASE_URL ?? "http://127.0.0.1:3000"
const apiKey = process.env.DATOOL_API_KEY?.trim()
const projectId = process.env.DATOOL_PROJECT_ID?.trim()

try {
  if (!apiKey || !projectId) {
    throw new Error("DATOOL_API_KEY and DATOOL_PROJECT_ID are required for project-scoped demo ingestion.")
  }
  const result = await runDemoWorkflow(createTracer({ apiKey, baseUrl, projectId }))

  console.log(
    JSON.stringify(
      {
        datasetTemplate: result.dataset.name,
        evaluatorTemplate: result.evaluator.name,
        sessionId: result.sessionId,
        traceIds: result.traceIds,
      },
      null,
      2,
    ),
  )
} catch (error) {
  console.error("Failed to capture the Datool demo traces.")
  console.error(error)
  process.exitCode = 1
}
