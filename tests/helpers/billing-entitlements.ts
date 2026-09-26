import { strict as assert } from "node:assert"
import { Pool } from "pg"
import { db } from "../../lib/db"
import { billingDatabaseUrl } from "../../lib/billing-database"
import { createOrganizationKey } from "../../src/server/auth/key-management"
import {
  assertIngestionCapacity,
  getCloudUsage,
} from "../../src/server/billing/usage"
import { expireCloudTraces } from "../../src/server/billing/retention"
import { createTracerDatabase } from "../../src/server/tracer/db"
import { TracerService } from "../../src/server/tracer/service"
import { runTracerEffect as run } from "../../src/server/tracer/effect"
import { persistEvent } from "../../src/server/ingestion/persist"
import { POST as createProject } from "../../app/api/organizations/[organizationId]/projects/route"
import {
  POST as createTrace,
  GET as listTraces,
} from "../../app/api/traces/route"
import type { CloudPlan } from "../../src/lib/billing"
import { libraryScorerPreset } from "../../src/lib/tracer/scorers"
import { POST as createScorer } from "../../app/api/scorers/route"
import { POST as createEval } from "../../app/api/evals/route"

export async function verifyCloudEntitlements(
  organizationId: string,
  projectId: string,
  setPlan: (plan: CloudPlan) => Promise<void>,
  cookie: string
) {
  const database = createTracerDatabase(undefined, { projectId })
  const service = new TracerService(database)
  const usage = () => getCloudUsage(organizationId)
  const cap = (limit: number) =>
    db.query(
      "UPDATE organization_billing SET record_limit=$2 WHERE organization_id=$1",
      [organizationId, limit]
    )
  const quotaError = (error: unknown) =>
    (error as { status?: number }).status === 429
  await setPlan("core")
  assert.equal((await usage()).limit, 100_000)
  assert.equal((await usage()).retentionDays, 90)
  await cap(3)
  const trace = await run(
    service.createTrace({
      name: "First trace",
      status: "completed",
      output: "hello",
      spans: [{ name: "First span", status: "completed" }],
    })
  )
  assert.equal((await usage()).used, 2)
  await run(service.patchTrace(trace.id, { output: "updated" }))
  assert.equal((await usage()).used, 2)
  await assert.rejects(
    () =>
      run(
        service.createTrace({
          id: "atomic-rejected",
          name: "Two records",
          spans: [{ name: "Over quota" }],
        })
      ),
    quotaError
  )
  assert.equal(
    (await usage()).used,
    2,
    "An atomic failed batch must not consume usage"
  )
  assert.equal(
    (await db.query("SELECT id FROM traces WHERE id='atomic-rejected'"))
      .rowCount,
    0
  )
  const race = await Promise.allSettled([
    run(service.createSpan(trace.id, { name: "Concurrent A" })),
    run(service.createSpan(trace.id, { name: "Concurrent B" })),
  ])
  assert.equal(race.filter((result) => result.status === "fulfilled").length, 1)
  assert.equal((await usage()).used, 3)
  await run(
    service.patchTrace(trace.id, { output: "Still writable at the cap" })
  )
  assert.equal(
    (await run(service.getTrace(trace.id))).output,
    "Still writable at the cap"
  )
  await setPlan("pro")
  assert.equal((await usage()).limit, 1_000_000)
  assert.equal((await usage()).retentionDays, 365)
  assert.equal((await usage()).used, 3, "Upgrading must not reset usage")
  await run(service.createSpan(trace.id, { name: "After upgrade" }))
  const event = {
    id: crypto.randomUUID(),
    previousId: null,
    method: "POST" as const,
    path: "/api/traces",
    body: { id: "retry-trace", name: "Retry proof" },
  }
  await Promise.all([
    persistEvent(database, event),
    persistEvent(database, event),
  ])
  assert.equal((await usage()).used, 5, "Identical event retries count once")
  await db.query(
    "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES('retry-trace',$1,'Import retry','import','completed',now()::text) ON CONFLICT DO NOTHING",
    [projectId]
  )
  assert.equal((await usage()).used, 5, "An import conflict counts zero")
  await db.query("DELETE FROM traces WHERE id='retry-trace'")
  await cap(5)
  await assertIngestionCapacity(organizationId, projectId, event)
  await setPlan("pro")
  assert.equal(
    (await usage()).used,
    5,
    "Deleting records must not refund usage"
  )
  await db.query(
    "UPDATE organization_usage_month SET period_start=(period_start-interval '1 month')::date WHERE organization_id=$1",
    [organizationId]
  )
  assert.equal(
    (await usage()).used,
    0,
    "Previous-month usage does not consume this month"
  )
  await run(service.createTrace({ name: "New month" }))
  assert.equal((await usage()).used, 1)

  const old = await run(
    service.createTrace({
      name: "Retention candidate",
      spans: [{ name: "Retained with parent" }],
    })
  )
  const receiptEvent = {
    id: crypto.randomUUID(),
    previousId: null,
    method: "PATCH" as const,
    path: `/api/traces/${old.id}`,
    body: { output: "Sensitive receipt payload" },
  }
  await persistEvent(database, receiptEvent)
  const importedSpan = (
    await db.query("SELECT id FROM spans WHERE trace_id=$1", [old.id])
  ).rows[0].id
  await db.query(
    `INSERT INTO langfuse_import_runs(id,project_id,host,source_project_id,from_time,to_time,page_size)
     VALUES('retention-import',$1,'https://example.test','source','2020-01-01','2026-01-01',100)`,
    [projectId]
  )
  for (const [id, kind] of [
    [old.id, "traces"],
    [importedSpan, "observations"],
  ]) {
    await db.query(
      `INSERT INTO langfuse_import_records(run_id,project_id,kind,source_id,raw,status,destination_id)
       VALUES('retention-import',$1,$2,$3,'{"output":"Sensitive imported payload"}','imported',$3)`,
      [projectId, kind, id]
    )
    await db.query(
      `INSERT INTO langfuse_import_entities(id,project_id,kind,raw)
       VALUES($1,$2,$3,'{"output":"Sensitive imported payload"}')`,
      [id, projectId, kind]
    )
  }
  const pinned = await run(service.createTrace({ name: "Dataset evidence" }))
  const dataset = await run(service.createDataset({ name: "Pinned evidence" }))
  await run(
    service.createDatasetItem(dataset.id, {
      input: "Evidence",
      sourceTraceId: pinned.id,
    })
  )
  await db.query(
    "UPDATE traces SET stored_at=now()-interval '180 days' WHERE id=ANY($1::text[])",
    [[old.id, pinned.id]]
  )
  assert.equal(await expireCloudTraces(), 0, "Pro retains 180-day-old traces")
  await setPlan("core")
  assert.equal(
    await expireCloudTraces(),
    1,
    "Core expires unpinned traces after 90 days"
  )
  assert.equal(
    (await db.query("SELECT id FROM spans WHERE trace_id=$1", [old.id]))
      .rowCount,
    0
  )
  assert.equal(
    (await db.query("SELECT id FROM traces WHERE id=$1", [pinned.id])).rowCount,
    1
  )
  assert.equal(
    (await usage()).used,
    4,
    "Retention does not rewrite metered usage"
  )
  assert.deepEqual(
    await persistEvent(database, receiptEvent),
    { id: old.id, expired: true },
    "An expired retry returns only a tombstone"
  )
  assert.equal(
    (await db.query("SELECT id FROM traces WHERE id=$1", [old.id])).rowCount,
    0
  )
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM langfuse_import_records WHERE run_id='retention-import' AND raw <> '{}'::jsonb"
      )
    ).rowCount,
    0
  )
  assert.equal(
    (
      await db.query(
        "SELECT 1 FROM langfuse_import_entities WHERE id=ANY($1::text[]) AND raw <> '{}'::jsonb",
        [[old.id, importedSpan]]
      )
    ).rowCount,
    0
  )
  await db.query(
    "UPDATE organization_billing SET status='past_due',access_until=now()-interval '1 second',grace_until=now()-interval '1 second' WHERE organization_id=$1",
    [organizationId]
  )
  await assert.rejects(
    () => run(service.createTrace({ name: "Expired grace" })),
    (error: unknown) => (error as { status?: number }).status === 402
  )
  await setPlan("core")

  // Fresh signup -> organization -> payment has run in billing-integration.ts.
  // Continue through actual project/key/trace HTTP handlers with persisted auth.
  const response = await createProject(
    new Request(
      `http://localhost:3000/api/organizations/${organizationId}/projects`,
      {
        method: "POST",
        headers: {
          cookie,
          origin: "http://localhost:3000",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: "Cloud onboarding",
          slug: "cloud-onboarding",
        }),
      }
    ),
    { params: Promise.resolve({ organizationId }) }
  )
  assert.equal(response.status, 201)
  const created = (await response.json()).project
  const key = await createOrganizationKey(
    new Request("http://localhost:3000/api/organizations/keys", {
      headers: { cookie, origin: "http://localhost:3000" },
    }),
    organizationId,
    {
      name: "Cloud ingestion",
      expiresIn: null,
      scopes: ["traces:write", "traces:read"],
    }
  )
  assert(key.key)
  const headers = {
    authorization: `Bearer ${key.key}`,
    "x-project-id": created.id,
    "content-type": "application/json",
  }
  const ingested = await createTrace(
    new Request("http://localhost:3000/api/traces", {
      method: "POST",
      headers,
      body: JSON.stringify({
        name: "Cloud customer's first trace",
        output: '{"message":"hello"}',
        status: "completed",
      }),
    })
  )
  assert.equal(ingested.status, 200)
  const firstTrace = (await ingested.json()).data
  const listed = await listTraces(
    new Request("http://localhost:3000/api/traces", { headers })
  )
  assert.equal(listed.status, 200)
  assert.equal(
    (await listed.json()).data.items[0].name,
    "Cloud customer's first trace"
  )
  await cap((await usage()).used)
  const blocked = await createTrace(
    new Request("http://localhost:3000/api/traces", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Over limit" }),
    })
  )
  assert.equal(blocked.status, 429)
  assert.equal(
    (await blocked.json()).error.details.reason,
    "RECORD_LIMIT_REACHED"
  )
  assert(Number(blocked.headers.get("retry-after")) > 0)
  assert.equal(
    (
      await listTraces(
        new Request("http://localhost:3000/api/traces", { headers })
      )
    ).status,
    200
  )
  await setPlan("core")
  const browserHeaders = {
    cookie,
    origin: "http://localhost:3000",
    "x-project-id": created.id,
    "content-type": "application/json",
  }
  const scorerResponse = await createScorer(
    new Request("http://localhost:3000/api/scorers", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify(libraryScorerPreset("ValidJSON")),
    })
  )
  assert.equal(scorerResponse.status, 200)
  const scorer = (await scorerResponse.json()).data
  const evaluated = await createEval(
    new Request("http://localhost:3000/api/evals", {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        name: "Cloud first evaluation",
        traceIds: [firstTrace.id],
        evaluatorIds: [scorer.id],
      }),
    })
  )
  assert.equal(evaluated.status, 200)
  const evaluation = (await evaluated.json()).data
  assert.equal(evaluation.status, "completed")
  assert.equal(evaluation.results[0].score, 1)
  assert.equal(
    (
      await db.query("SELECT id FROM eval_runs WHERE id=$1 AND project_id=$2", [
        evaluation.id,
        created.id,
      ])
    ).rowCount,
    1
  )

  // Disabled installations use fresh connections with enforcement disabled.
  process.env.DATOOL_BILLING_ENABLED = "false"
  const selfHosted = new Pool({
    connectionString: billingDatabaseUrl(process.env.DATABASE_URL!),
  })
  try {
    await selfHosted.query(
      "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES('self-hosted-proof',$1,'Self hosted','test','completed',now()::text)",
      [projectId]
    )
    assert.equal(await expireCloudTraces(), 0)
  } finally {
    await selfHosted.end()
    process.env.DATOOL_BILLING_ENABLED = "true"
  }
  await setPlan("core")
}
