import { http, HttpResponse } from "msw"
import {
  envelope,
  list,
  storybookSession,
  storybookSessionDetail,
  storybookTraceId,
  traceDetail,
  traceOverview,
  traceRow,
  traceRows,
  traceSpans,
} from "./fixtures"

export const traceHandlers = [
  http.get("/api/custom-fields", () => HttpResponse.json(envelope([]))),
  http.get("/api/traces", () => HttpResponse.json(envelope(list(traceRows)))),
  http.get(`/api/traces/${storybookTraceId}`, () =>
    HttpResponse.json(envelope(traceDetail))
  ),
  http.get(`/api/traces/${storybookTraceId}/overview`, () =>
    HttpResponse.json(envelope(traceOverview))
  ),
  http.get(`/api/traces/${storybookTraceId}/payload`, () =>
    HttpResponse.json(envelope(traceRow))
  ),
  http.get(`/api/traces/${storybookTraceId}/spans`, () =>
    HttpResponse.json(envelope(list(traceSpans)))
  ),
  http.get(
    `/api/traces/${storybookTraceId}/spans/:spanId/detail`,
    ({ params }) =>
      HttpResponse.json(
        envelope(
          traceSpans.find((span) => span.id === params.spanId) ?? traceSpans[0]
        )
      )
  ),
  http.get(`/api/traces/${storybookTraceId}/scores`, () =>
    HttpResponse.json(
      envelope(
        list(
          traceDetail.scores.map((score, index) => ({
            ...score,
            id: score.evalResultId ?? `score-storybook-${index}`,
          }))
        )
      )
    )
  ),
]

export const sessionHandlers = [
  http.get("/api/sessions", () =>
    HttpResponse.json(envelope(list([storybookSession])))
  ),
  http.get(`/api/sessions/${storybookSession.id}`, () =>
    HttpResponse.json(envelope(storybookSessionDetail))
  ),
]

export const onboardingHandlers = [
  http.get("/api/organizations/:organizationId/api-keys", () =>
    HttpResponse.json(envelope({ canManage: true, creationDisabled: false }))
  ),
  http.post("/api/organizations/:organizationId/api-keys", () =>
    HttpResponse.json(envelope({ key: "dtl_storybook_fixture_key" }))
  ),
]
