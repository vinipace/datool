import { http, HttpResponse } from "msw"
import type { ReactView } from "@/src/lib/tracer/react-views"
export const storybookReactView: ReactView = {
  id: "shared-view",
  projectId: "storybook-project",
  name: "Answer view",
  description: "Reusable project view",
  code: 'import * as React from "react"; export default function View({trace}: ViewProps) { return <pre>{JSON.stringify(trace.output)}</pre> }',
  requirements: null,
  dataMode: "full",
  origin: null,
  author: { id: "author", name: "Example author", kind: "session" },
  revision: 1,
  createdAt: "2026-09-25T00:00:00Z",
  updatedAt: "2026-09-25T00:00:00Z",
}
export function reactViewHandlers(views: ReactView[] = []) {
  return [
    http.get("/api/react-views", () =>
      HttpResponse.json({
        data: {
          items: views.map(({ code, ...view }) => {
            void code
            return view
          }),
          nextCursor: null,
        },
      })
    ),
    http.get("/api/react-views/:id", ({ params }) => {
      const view = views.find((view) => view.id === params.id)
      return view
        ? HttpResponse.json({ data: view })
        : HttpResponse.json(
            { error: { message: "View not found" } },
            { status: 404 }
          )
    }),
  ]
}
