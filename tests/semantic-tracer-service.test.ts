import { afterEach, describe, expect, test } from "bun:test"

import { runTracerEffect } from "@/src/server/tracer/effect"
import { TracerError } from "@/src/server/tracer/errors"
import { createTestTracerService } from "@/src/server/tracer/service"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const fixtures = new Set<IsolatedPostgres>()

afterEach(async () => {
  await Promise.all([...fixtures].map((fixture) => fixture.close()))
  fixtures.clear()
})

async function makeService() {
  const fixture = await createIsolatedPostgres()
  fixtures.add(fixture)
  await migrateIsolatedPostgres(fixture)
  await seedTestWorkspace(fixture)
  return createTestTracerService(fixture.databaseUrl, fixture.projectId)
}

async function capturedError(operation: () => Promise<unknown>) {
  try {
    await operation()
    return undefined
  } catch (error) {
    return error
  }
}

describe("TracerService semantic adapters", () => {
  test("exposes catalog discovery and a bounded score query through the existing Effect boundary", async () => {
    const service = await makeService()
    const metadata = await runTracerEffect(service.getSemanticMetricsMetadata())
    expect(metadata.models.map((model) => model.name)).toEqual([
      "agents",
      "evalClassification",
      "evalComparison",
      "evalQuality",
      "evalResults",
      "evalRuns",
      "logs",
      "scoreValues",
      "scores",
      "spans",
      "traces",
      "workflows",
    ])

    const result = await runTracerEffect(
      service.querySemanticMetrics({
        measures: ["scores.scoredCount"],
        timeDimensions: [
          {
            dateRange: ["2026-09-01T00:00:00.000Z", "2026-09-02T00:00:00.000Z"],
            dimension: "scores.completedAt",
          },
        ],
      })
    )

    expect(result.meta.contractVersion).toBe("datool-semantic-v2")
    expect(result.data).toEqual([
      { "scores.completedAt": null, "scores.scoredCount": 0 },
    ])
  })

  test("maps malformed semantic query input into the established API error class", async () => {
    const service = await makeService()
    const error = await capturedError(() =>
      runTracerEffect(service.querySemanticMetrics({}))
    )

    expect(error).toBeInstanceOf(TracerError)
    expect(error).toMatchObject({
      code: "VALIDATION_ERROR",
      details: { semanticCode: "INVALID_QUERY" },
    })
  })
})
