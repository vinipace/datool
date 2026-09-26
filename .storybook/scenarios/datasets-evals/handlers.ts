import { http, HttpResponse } from "msw"
import { modelProviderHandlers } from "../model-providers"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"
import {
  apiError,
  availableApps,
  comparisonRun,
  customField,
  dataset,
  datasetDetail,
  datasetItems,
  datasetLibraryEntries,
  datasetVersions,
  envelope,
  evaluator,
  evaluators,
  evalComparison,
  evalRun,
  evalRunSummaries,
  list,
  playgroundDetail,
  scorerRows,
  supportLibraryEntries,
  traceDetail,
  traceRows,
} from "./fixtures"

export function data<T>(value: T) {
  return HttpResponse.json(envelope(value))
}

export function failure(message: string, status = 500) {
  return HttpResponse.json(apiError(message), { status })
}

const customFields: ComputedColumn[] = [customField]

/**
 * Reusable REST handlers use the same serialized contracts as the client
 * components. Stories override an individual route for loading and failure
 * states, rather than replacing product calls with local component mocks.
 */
export const datasetsEvalsHandlers = [
  http.get("/api/prompts", () => data([{ id: "prompt-brand", name: "Brand extraction", slug: "brand-extraction", publishedVersion: 3 }])),
  ...modelProviderHandlers,
  http.get("/api/custom-fields", () => data(customFields)),
  http.post("/api/custom-fields", async ({ request }) => {
    const body = (await request.json()) as { field: ComputedColumn }
    return data(body.field)
  }),
  http.get("/api/custom-views", () => data([])),
  http.get("/api/views", () => data(list([]))),
  http.get("/api/datasets/library", ({ request }) => {
    const folderId = new URL(request.url).searchParams.get("folderId")
    return data(
      list(
        folderId === "folder-storybook-support"
          ? supportLibraryEntries
          : datasetLibraryEntries
      )
    )
  }),
  http.post("/api/datasets/library", () =>
    data({ ...datasetLibraryEntries[1], folders: [] })
  ),
  http.patch("/api/datasets/library", () =>
    data({ id: dataset.id, name: dataset.name })
  ),
  http.get("/api/datasets/:datasetId/versions", () =>
    data(list(datasetVersions))
  ),
  http.get("/api/datasets/:datasetId/items", () => data(list(datasetItems))),
  http.post("/api/datasets/:datasetId/items", () => data(datasetItems[0])),
  http.get("/api/datasets/:datasetId", () => data(datasetDetail)),
  http.patch("/api/datasets/:datasetId", () => data(dataset)),
  http.get("/api/datasets", () => data(list([dataset]))),
  http.post("/api/datasets", () => data(dataset)),
  http.patch("/api/dataset-items/:itemId", () => data(datasetItems[0])),
  http.delete("/api/dataset-items/:itemId", ({ params }) =>
    data({ id: String(params.itemId) })
  ),
  http.post("/api/agent/bulk_dataset_items", () =>
    data({ imported: datasetItems.length })
  ),
  http.get("/api/evaluators", () => data(list(evaluators))),
  http.get("/api/evals/compare", () => data(evalComparison)),
  http.get("/api/evals/:runId/targets/:targetId", ({ params }) => {
    const run = String(params.runId) === comparisonRun.id ? comparisonRun : evalRun
    const row = run.rows?.find(row => row.id === String(params.targetId))
    return row ? data({ ...row, scoringTrace: row.scoringTrace ?? traceDetail }) : failure("Eval target not found", 404)
  }),
  http.get("/api/evals/:runId", ({ params }) =>
    data(String(params.runId) === comparisonRun.id ? comparisonRun : evalRun)
  ),
  http.get("/api/evals", () => data(list(evalRunSummaries))),
  http.post("/api/evals", () => data(evalRun)),
  http.get("/api/traces/:traceId", () => data(traceDetail)),
  http.get("/api/traces", () => data(list(traceRows))),
  http.get("/api/apps/config", () => data(availableApps)),
  http.get("/api/apps", () =>
    data([
      {
        id: availableApps[0].id,
        mode: availableApps[0].mode,
        name: availableApps[0].name,
        url: "https://example.test/invoice-assistant",
      },
    ])
  ),
  http.post("/api/apps", () =>
    data({
      id: "app-storybook-new",
      mode: "input" as const,
      name: "New app",
      url: "https://example.test/new-app",
    })
  ),
  http.post("/api/apps/:appId/call", () =>
    data({ answer: "Your September invoice is ready in the billing portal." })
  ),
  http.get("/api/playgrounds/:playgroundId", () => data(playgroundDetail)),
  http.post("/api/playgrounds/:playgroundId", () => data(playgroundDetail)),
  http.get("/api/playgrounds", () => data([playgroundDetail.playground])),
  http.post("/api/playgrounds", () => data(playgroundDetail)),
  http.post("/api/scorers/test", () =>
    data({
      passed: true,
      reasoning: "The response matches the expected answer.",
      score: 1,
    })
  ),
  http.get("/api/scorers/:scorerId", () => data(scorerRows[0])),
  http.put("/api/scorers/:scorerId", () => data(scorerRows[0])),
  http.delete("/api/scorers/:scorerId", () => data({ id: scorerRows[0].id })),
  http.get("/api/scorers", () => data(scorerRows)),
  http.post("/api/scorers", () => data(scorerRows[0])),
]

export const datasetsEvalsErrorHandlers = {
  datasets: http.get("/api/datasets", () => failure("Could not load datasets")),
  evals: http.get("/api/evals", () => failure("Could not load eval runs")),
  playgrounds: http.get("/api/playgrounds", () =>
    failure("Could not load playgrounds")
  ),
  scorers: http.get("/api/scorers", () => failure("Could not load scorers")),
}

export const emptyEvaluatorResponse = () => data(list([evaluator]))

export const emptyDatasetResponse = () => data(list([]))

export const emptyEvalResponse = () => data(list([]))
