import type {
  CustomView,
  EvalViewSettings,
} from "@/src/lib/tracer/custom-views"
import { http, HttpResponse } from "msw"
import { envelope } from "./fixtures"

export const storybookViewSettings: EvalViewSettings = {
  columnOrder: ["name", "score"],
  columnSizing: { name: 260, score: 140 },
  columnVisibility: { name: true, score: true },
  computedColumns: [],
  detailsOpen: false,
  schemaVersion: 1,
  view: "table",
}

export const storybookCustomView: CustomView = {
  createdAt: "2026-09-10T14:00:00.000Z",
  id: "custom-view-storybook-001",
  name: "Review layout",
  resource: "eval-runs",
  revision: 1,
  settings: storybookViewSettings,
  updatedAt: "2026-09-10T14:30:00.000Z",
}

export const customViewHandlers = [
  http.get("/api/custom-views", () =>
    HttpResponse.json(envelope([storybookCustomView]))
  ),
  http.get(`/api/custom-views/${storybookCustomView.id}`, () =>
    HttpResponse.json(envelope(storybookCustomView))
  ),
  http.post("/api/custom-views", async ({ request }) => {
    const input = (await request.json()) as Omit<
      CustomView,
      "id" | "revision" | "createdAt" | "updatedAt"
    >
    return HttpResponse.json(
      envelope({
        ...input,
        createdAt: "2026-09-10T14:35:00.000Z",
        id: "custom-view-storybook-created",
        revision: 1,
        updatedAt: "2026-09-10T14:35:00.000Z",
      })
    )
  }),
  http.patch(`/api/custom-views/${storybookCustomView.id}`, () =>
    HttpResponse.json(envelope({ ...storybookCustomView, revision: 2 }))
  ),
  http.delete(`/api/custom-views/${storybookCustomView.id}`, () =>
    HttpResponse.json(envelope({ id: storybookCustomView.id }))
  ),
]
