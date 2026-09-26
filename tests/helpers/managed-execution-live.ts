// Opt-in live provider check. The launcher supplies an isolated local schema;
// no customer subscription, balance, or provider settings are modified.
import { writeFile } from "node:fs/promises"
import { db, analyticsDb } from "../../lib/db"
import { executionCredits } from "../../src/server/execution-credits/ledger"
import { TracerService } from "../../src/server/tracer/service"
import { createTracerDatabase } from "../../src/server/tracer/db"
import { runTracerEffect as run } from "../../src/server/tracer/effect"
import { defaultScorer } from "../../src/lib/tracer/scorers"
import { defaultLibraryScorer } from "../../src/lib/tracer/scorer-libraries"
import { updateSandboxProviderSettings } from "../../src/server/sandbox/providers-store"
import { ModalClient } from "modal"

const organizationId = process.env.TEST_ORGANIZATION_ID!
const projectId = process.env.TEST_PROJECT_ID!
if (
  !new URL(process.env.DATABASE_URL!).searchParams
    .get("options")
    ?.includes("datool_test_")
)
  throw new Error("An isolated test schema is required")
const report: Record<string, unknown> = {
  organizationId,
  projectId,
  testGrant: true,
}
try {
  await db.query(
    `INSERT INTO organization_billing(organization_id,subscription_id,price_id,status,access_until,current_period_end,plan,record_limit,retention_days,synced_at,checkout_attempt_id) VALUES($1,'live_fixture','price_core','active',now()+interval '1 hour',now()+interval '1 hour','core',100000,90,now(),'fixture')`,
    [organizationId]
  )
  await executionCredits.grant({
    organizationId,
    subscriptionId: "live_fixture",
    invoiceId: "live_fixture",
    start: new Date(Date.now() - 1000),
    end: new Date(Date.now() + 3600000),
    plan: "core",
  })
  // Limit this disposable fixture's entire run, including retries, to US$0.03.
  await db.query("UPDATE execution_credit_period SET allowance=30000000")
  await db.query(
    "UPDATE execution_credit_ledger SET amount=30000000 WHERE kind='grant'"
  )
  const service = new TracerService(
    createTracerDatabase(undefined, { projectId })
  )
  const trace = await run(
    service.createTrace({
      name: "Managed execution live check",
      input: "What is 2 + 2?",
      output: "4",
      status: "completed",
    })
  )
  const scorer = await run(
    service.scorers.save({
      ...defaultScorer,
      name: "Datool live model",
      slug: "datool-live-model",
      provider: "datool",
      model: "gpt-6-luna",
      modelType: "language",
    })
  )
  const preview = await run(
    service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id })
  )
  report.modelPreview = preview.result
  console.log("Live model preview:", preview.result.error ? "failed" : "passed")
  if (!preview.result.error) {
    const evaluation = await run(
      service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] })
    )
    report.savedEvaluation = {
      id: evaluation.id,
      score: evaluation.results[0]?.score,
      status: evaluation.status,
    }
    const libraryConfig = defaultLibraryScorer("Factuality")
    const library = await run(
      service.scorers.save({
        ...defaultScorer,
        name: "Datool live library",
        slug: "datool-live-library",
        type: "library",
        provider: "datool",
        model: "gpt-6-luna",
        modelType: "language",
        library: {
          ...libraryConfig,
          mappings: { ...libraryConfig.mappings, expected: "trace.output" },
        },
      })
    )
    report.library = (
      await run(
        service.agent.testScorer({ traceId: trace.id, scorerId: library.id })
      )
    ).result
    console.log(
      "Live library scorer:",
      (report.library as { error?: unknown }).error ? "failed" : "passed"
    )
  }
  await updateSandboxProviderSettings(projectId, {
    type: "configure",
    input: { provider: "datool" },
  })
  await updateSandboxProviderSettings(projectId, {
    type: "default",
    provider: "datool",
  })
  for (const type of ["javascript", "python"] as const) {
    const code =
      type === "javascript"
        ? 'function evaluate({trace}) { return {score: trace.output === "4" ? 1 : 0}; }'
        : 'def evaluate(trace, dataset_item=None):\n    return {"score": 1 if trace["output"] == "4" else 0}'
    const saved = await run(
      service.scorers.save({
        ...defaultScorer,
        name: `Datool live ${type}`,
        slug: `datool-live-${type}`,
        type,
        code,
      })
    )
    const result = await run(
      service.agent.testScorer({ traceId: trace.id, scorerId: saved.id })
    )
    report[type] = result.result
    console.log(
      `Live ${type} sandbox:`,
      result.result.error ? "failed" : "passed"
    )
  }
  report.usage = await executionCredits.usage(organizationId)
  const operations = await db.query(
    "SELECT id,runtime,state,reserved,charged,provider_id,usage FROM execution_credit_operation ORDER BY created_at"
  )
  report.operations = operations.rows
  const modal = new ModalClient({
    tokenId: process.env.DATOOL_MODAL_TOKEN_ID!,
    tokenSecret: process.env.DATOOL_MODAL_TOKEN_SECRET!,
    timeoutMs: 10000,
    maxRetries: 0,
  })
  try {
    const shutdowns = []
    for (const operation of operations.rows.filter(
      (op) => op.runtime === "sandbox" && op.provider_id
    )) {
      const sandbox = await modal.sandboxes.fromId(operation.provider_id)
      shutdowns.push({
        id: operation.provider_id,
        exitCode: await sandbox.poll(),
      })
      sandbox.detach()
    }
    report.sandboxShutdowns = shutdowns
  } finally {
    modal.close()
  }
  const passed =
    !preview.result.error &&
    operations.rows.length === 5 &&
    operations.rows.every((op) => op.state !== "reserved") &&
    ["library", "javascript", "python"].every(
      (key) => !(report[key] as { error?: unknown })?.error
    ) &&
    (report.sandboxShutdowns as { exitCode: number | null }[]).every(
      (sandbox) => sandbox.exitCode !== null
    )
  report.passed = passed
  await writeFile(
    ".tmp/managed-execution-live.json",
    JSON.stringify(report, null, 2)
  )
  console.log(
    "Live execution evidence saved; used USD:",
    (report.usage as { used: number }).used
  )
  if (!passed) process.exitCode = 1
} finally {
  await db.end()
  await analyticsDb.end()
}
