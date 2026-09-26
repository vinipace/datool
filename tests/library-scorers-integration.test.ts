import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { defaultScorer } from "../src/lib/tracer/scorers"
import { defaultLibraryScorer } from "../src/lib/tracer/scorer-libraries"
import {
  createTracerFixture,
  closeTracerFixture,
} from "./helpers/tracer-fixture"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { TracerService } from "../src/server/tracer/service"
import { findAgentOperation } from "../src/server/mcp/operations"

test("library scorers persist, preview, pin versions and rescore frozen evidence through shared operations", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const catalog = findAgentOperation("list_scorer_libraries")!
    expect(catalog.scopes).toEqual(["scorers:read"])
    const discovered = (await run(catalog.execute(service, {}))) as {
      libraries: { evaluators: unknown[] }[]
    }
    expect(discovered.libraries[0].evaluators).toHaveLength(6)
    const library = defaultLibraryScorer()
    library.mappings.expected = "trace.input.answer"
    library.mappings.output = "trace.output.answer"
    const config = {
      ...defaultScorer,
      name: "Library equality",
      slug: "library-equality",
      type: "library" as const,
      code: "",
      library,
      threshold: 0.8,
    }
    const scorer = await run(service.scorers.save(config))
    const version1 = (await run(service.getEvaluator(scorer.id))).activeVersion
    expect(version1.config?.library).toEqual(library)
    const trace = await run(
      service.createTrace({
        name: "Library evidence",
        input: { answer: "4" },
        output: { answer: "4" },
        status: "completed",
      })
    )
    const readiness = await run(
      service.agent.checkScorerRuntime({ scorerIds: [scorer.id] })
    )
    expect(readiness.checks[0].configuration).toBe("present")
    const preview = await run(
      service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id })
    )
    expect(preview.result.score).toBe(1)
    const first = await run(
      service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] })
    )
    expect(first.status).toBe("completed")
    expect(first.results[0].score).toBe(1)
    const changed = {
      ...config,
      library: { ...library, evaluator: "Levenshtein" as const },
      expectedRevision: 1,
    }
    expect((await run(service.scorers.save(changed, scorer.id))).revision).toBe(
      2
    )
    expect(
      (await run(service.agent.getVersion(scorer.id, version1.id))).config
        ?.library?.evaluator
    ).toBe("ExactMatch")
    await run(service.patchTrace(trace.id, { output: { answer: "different" } }))
    const second = await run(
      service.createEvalRun({
        evaluatorIds: [scorer.id],
        evaluatorVersionIds: { [scorer.id]: version1.id },
        sourceRunId: first.id,
      })
    )
    expect(second.results[0].score).toBe(1)
    expect(second.results[0].metadata.library).toMatchObject({
      evaluator: "ExactMatch",
      version: "0.3.0",
      adapterVersion: 1,
    })
    const after = await run(service.getTraceArtifact(trace.id))
    expect(
      after.spans.some((span) => span.attributes["scorer.type"] === "library")
    ).toBe(true)
    await rejects(
      run(service.scorers.save({ ...changed, expectedRevision: 1 }, scorer.id)),
      /Scorer changed/
    )
  } finally {
    await closeTracerFixture(db)
  }
}, 30_000)

test("direct library selection reuses one project scorer and preserves subsequent edits", async () => {
  const db = await createTracerFixture()
  try {
    const service = new TracerService(db)
    const selections = await Promise.all(
      Array.from({ length: 4 }, () =>
        run(service.scorers.useLibrary({ evaluator: "ExactMatch" }))
      )
    )
    expect(new Set(selections.map((scorer) => scorer.id)).size).toBe(1)
    expect(selections.every((scorer) => scorer.revision === 1)).toBe(true)
    const scorer = selections[0]
    const updated = await run(
      service.scorers.save(
        { ...scorer, threshold: 0.9, expectedRevision: 1 },
        scorer.id
      )
    )
    const reused = await run(
      service.scorers.useLibrary({ evaluator: "ExactMatch" })
    )
    expect(reused).toEqual(updated)
    const model = await run(
      service.scorers.useLibrary({ evaluator: "Factuality" })
    )
    expect(model.model).toBe("openai/gpt-4.1-mini")
    expect(model.library?.evaluator).toBe("Factuality")
    await rejects(run(service.scorers.useLibrary({ evaluator: "arbitrary" })))
    await run(
      service.scorers.save(
        {
          ...updated,
          library: defaultLibraryScorer("JSONDiff"),
          expectedRevision: 2,
        },
        scorer.id
      )
    )
    await rejects(
      run(service.scorers.useLibrary({ evaluator: "ExactMatch" })),
      /configuration has changed/
    )
  } finally {
    await closeTracerFixture(db)
  }
}, 30_000)
