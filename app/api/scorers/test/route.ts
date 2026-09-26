import { api } from "@/src/server/tracer/http"
import { tracerEffect } from "@/src/server/tracer/effect"
import { requireScopes } from "@/src/server/auth/request"
import { z } from "zod"
import { readJson } from "@/src/server/tracer/http"
import { validation } from "@/src/server/tracer/errors"
import { executeScorer } from "@/src/server/tracer/scorer-runtime"
import { scorerInputSchema } from "@/src/lib/tracer/scorers"
import type { JsonValue } from "@/src/lib/tracer/contracts"
export const runtime = "nodejs"
const schema = z.object({
  config: scorerInputSchema.optional(),
  threshold: z.number().min(0).max(1).nullable().optional(),
  code: z.string().max(128000).default(""),
  traceId: z.string().trim().min(1).max(200).optional(),
  sample: z
    .object({
      input: z.json(),
      output: z.json(),
      expected: z.json().optional(),
    })
    .optional(),
})
export async function POST(request: Request) {
  return api<unknown>(
    request,
    async (service, context) => {
      const parsed = schema.safeParse(await readJson(request))
      if (!parsed.success)
        throw validation(
          parsed.error.issues.find(
            (issue) => issue.path[0] === "config" && issue.code === "custom"
          )?.message ??
            "Provide a valid scorer configuration and a sample with input and output JSON values."
        )
      const { code, sample, threshold, config, traceId } = parsed.data
      if (traceId) {
        if (!config || sample)
          throw validation(
            "Provide a scorer config and either traceId or sample, not both."
          )
        requireScopes(context.identity.scopes, ["traces:read"])
        return service.agent.testScorer({ traceId, scorer: config })
      }
      if (!sample)
        throw validation(
          "Provide a traceId or a sample with input and output JSON values."
        )
      return tracerEffect(async () => {
        const data = await executeScorer(
          {
            id: "sample",
            evaluatorId: "sample",
            version: 1,
            createdAt: new Date().toISOString(),
            language: config?.type === "python" ? "python" : "javascript",
            code,
            config,
          },
          {
            id: "sample",
            name: "Sample",
            operation: "scorer-test",
            sessionId: null,
            status: "completed",
            startedAt: new Date().toISOString(),
            endedAt: null,
            attributes: {},
            spans: [],
            input: sample.input as JsonValue,
            output: sample.output as JsonValue,
          },
          {
            id: "sample",
            datasetId: "sample",
            sourceTraceId: null,
            input: sample.input as JsonValue,
            expectedOutput: (sample.expected as JsonValue) ?? null,
            metadata: {},
          },
          context.identity.projectId
        )
        if (!data.error && data.score !== null && threshold != null)
          data.passed = data.score >= threshold
        return data
      })
    },
    { mutation: true }
  )
}
