import assert from "node:assert/strict"
import { afterAll, beforeAll, expect, test } from "bun:test"
import { Pool } from "pg"
import { mkdir, writeFile } from "node:fs/promises"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "./helpers/postgres"
import { createTestAlertReader } from "./helpers/alert-reader"
import {
  AlertEvaluator,
  AlertEvaluationBusy,
  AlertEvaluationLimit,
} from "../src/server/alerts/evaluator"
import { alertLimits, consumeAlertBudget } from "../src/server/alerts/budgets"
import { provisionAlertReader } from "../src/server/alerts/provision"
import { createAlert, updateAlert } from "../src/server/alerts/service"
import {
  evaluateAlert,
  processAlertDelivery,
} from "../src/server/alerts/worker"
import { defaultAlertConfig } from "../src/lib/alerts/contracts"

let target: IsolatedPostgres
let reader: Awaited<ReturnType<typeof createTestAlertReader>>
let writer: Pool
let evaluator: AlertEvaluator
const proof: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  environment: "Disposable PostgreSQL 17; real dedicated restricted login",
}

beforeAll(async () => {
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  writer = new Pool({ connectionString: target.databaseUrl })
  reader = await createTestAlertReader(target)
  evaluator = new AlertEvaluator(reader.databaseUrl)
})

afterAll(async () => {
  await evaluator?.close()
  await writer?.end()
  await target?.close()
  await reader?.close()
  await mkdir("artifacts/alerts-e2e", { recursive: true })
  await writeFile(
    "artifacts/alerts-e2e/security-proof.json",
    JSON.stringify({ ...proof, completedAt: new Date().toISOString() }, null, 2)
  )
})

async function project() {
  const id = crypto.randomUUID()
  await writer.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Security test',$1)",
    [id, target.organizationId]
  )
  return id
}
async function trace(projectId: string, name: string) {
  await writer.query(
    "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES($1,$2,$3,'test','errored',$4)",
    [crypto.randomUUID(), projectId, name, new Date().toISOString()]
  )
}

// These assertions use the restricted credentials directly, bypassing our parser.
test("reader has no base-table access or writes; the database view enforces project scope and clears pooled scope", async () => {
  const a = await project(),
    b = await project()
  await trace(a, "project-a")
  await trace(b, "project-b")
  const raw = new Pool({ connectionString: reader.databaseUrl, max: 1 })
  try {
    expect(
      (await raw.query("SHOW default_transaction_read_only")).rows[0]
        .default_transaction_read_only
    ).toBe("on")
    expect(
      (await raw.query("SELECT count(*) FROM alert_evaluation_logs")).rows[0]
        .count
    ).toBe("0")
    await raw.query("SET default_transaction_read_only=off")
    for (const sql of [
      "SELECT * FROM traces",
      "SELECT * FROM project",
      "UPDATE traces SET name='stolen'",
      "DELETE FROM project_alerts",
      "TRUNCATE traces",
      "DROP TABLE traces",
      "CREATE TABLE alert_reader_escape(id int)",
    ]) {
      await assert.rejects(raw.query(sql))
    }
    const result = await evaluator.read(a, (query) =>
      query(
        "SELECT payload->>'name' AS name FROM alert_evaluation_logs WHERE true OR payload->>'name'='project-b'"
      )
    )
    expect(result.rows).toEqual([{ name: "project-a" }])
    expect(
      (
        await evaluator.read(b, (query) =>
          query("SELECT payload->>'name' AS name FROM alert_evaluation_logs")
        )
      ).rows
    ).toEqual([{ name: "project-b" }])
    expect(
      (await raw.query("SELECT count(*) FROM alert_evaluation_logs")).rows[0]
        .count
    ).toBe("0")
    await evaluator.read(a, async (query) => {
      await query("SELECT set_config('datool.alert_project_id','',true)")
      expect(
        (await query("SELECT count(*) FROM alert_evaluation_logs")).rows[0]
          .count
      ).toBe("0")
    })
    // Provisioning is repeatable, but cannot silently repurpose the writer login.
    await provisionAlertReader(writer, reader.databaseUrl)
    await assert.rejects(
      provisionAlertReader(writer, target.databaseUrl),
      /separate reader/
    )
    const unsafe = new AlertEvaluator(target.databaseUrl)
    try {
      await assert.rejects(
        unsafe.read(a, (query) => query("SELECT 1")),
        /restricted login/
      )
    } finally {
      await unsafe.close()
    }
    proof.databaseBoundary = {
      directBaseReadsDenied: true,
      writesDenied: true,
      unscopedRows: 0,
      foreignRows: 0,
      unsafeLoginRejected: true,
    }
  } finally {
    await raw.end()
  }
})

test("project quotas are atomic across connections and survive rule changes", async () => {
  const id = await project()
  const parallel = await Promise.all(
    Array.from({ length: 45 }, () => consumeAlertBudget(writer, id, "mutation"))
  )
  expect(parallel.filter(Boolean)).toHaveLength(alertLimits.mutationsPerMinute)
  const evaluations = await Promise.all(
    Array.from({ length: 135 }, () =>
      consumeAlertBudget(writer, id, "evaluation")
    )
  )
  expect(evaluations.filter(Boolean)).toHaveLength(
    alertLimits.evaluationsPerMinute
  )
  const rule = await createAlert(
    id,
    { ...defaultAlertConfig, name: "Over quota", type: "time_window" },
    writer
  )
  await evaluateAlert(writer, rule.id, evaluator)
  expect(
    (
      await writer.query("SELECT last_error FROM project_alerts WHERE id=$1", [
        rule.id,
      ])
    ).rows[0].last_error
  ).toContain("Project evaluation limit")
  const healthy = await project()
  expect(await consumeAlertBudget(writer, healthy, "evaluation")).toBe(true)
  await writer.query(
    "UPDATE alert_project_budgets SET window_start=window_start-interval '1 minute' WHERE project_id=$1",
    [id]
  )
  expect(await consumeAlertBudget(writer, id, "mutation")).toBe(true)
  expect(await consumeAlertBudget(writer, id, "evaluation")).toBe(true)
  proof.quotas = {
    changesAcceptedOf45: 30,
    evaluationsAcceptedOf135: 120,
    otherProjectUnaffected: true,
    nextWindowRecovers: true,
  }
})

test("global two-query and per-project one-query limits hold across independent worker pools without queuing", async () => {
  const other = new AlertEvaluator(reader.databaseUrl),
    third = new AlertEvaluator(reader.databaseUrl)
  let releaseA!: () => void,
    releaseB!: () => void,
    enteredA!: () => void,
    enteredB!: () => void
  const holdA = new Promise<void>((resolve) => {
    releaseA = resolve
  })
  const holdB = new Promise<void>((resolve) => {
    releaseB = resolve
  })
  const readyA = new Promise<void>((resolve) => {
    enteredA = resolve
  })
  const readyB = new Promise<void>((resolve) => {
    enteredB = resolve
  })
  const a = evaluator.read("concurrent-a", async () => {
    enteredA()
    await holdA
  })
  const b = other.read("concurrent-b", async () => {
    enteredB()
    await holdB
  })
  try {
    await Promise.all([readyA, readyB])
    const start = Date.now()
    await assert.rejects(
      third.read("concurrent-c", (query) => query("SELECT 1")),
      AlertEvaluationBusy
    )
    expect(Date.now() - start).toBeLessThan(500)
    releaseB()
    await b
    await assert.rejects(
      third.read("concurrent-a", (query) => query("SELECT 1")),
      AlertEvaluationBusy
    )
    expect(
      (await third.read("concurrent-c", (query) => query("SELECT 1 AS ok")))
        .rows[0].ok
    ).toBe(1)
    proof.concurrency = {
      global: 2,
      perProject: 1,
      excessWorkRejectedWithoutQueue: true,
    }
  } finally {
    releaseA()
    releaseB()
    await Promise.allSettled([a, b])
    await other.close()
    await third.close()
  }
})

test("slow statements and multi-statement evaluations are cancelled; capacity recovers", async () => {
  const start = Date.now()
  await assert.rejects(
    evaluator.read("slow", (query) => query("SELECT pg_sleep(4)")),
    AlertEvaluationLimit
  )
  const statementMs = Date.now() - start
  expect(statementMs).toBeLessThan(2300)
  const totalStart = Date.now()
  await assert.rejects(
    evaluator.read("slow", async (query) => {
      for (let i = 0; i < 4; i++) await query("SELECT pg_sleep(0.9)")
    }),
    AlertEvaluationLimit
  )
  const totalMs = Date.now() - totalStart
  expect(totalMs).toBeLessThan(3300)
  expect(
    (await evaluator.read("slow", (query) => query("SELECT 1 AS ok"))).rows[0]
      .ok
  ).toBe(1)
  const active = await writer.query(
    "SELECT count(*) FROM pg_stat_activity WHERE application_name='datool-alert-reader' AND state='active' AND query LIKE '%pg_sleep%'"
  )
  expect(active.rows[0].count).toBe("0")
  proof.cancellation = {
    statementMs,
    totalMs,
    noOrphanQuery: true,
    poolRecovered: true,
  }
}, 10000)

test("20,001-row window rejects partial results, pauses after three failures, and leaves other projects and deliveries working", async () => {
  const overloaded = await project(),
    foreign = await project()
  const start = Date.now()
  for (const id of [overloaded, foreign]) {
    await writer.query(
      `INSERT INTO traces(id,project_id,name,operation,status,started_at)
      SELECT $1||'-'||n,$1,'load-'||n,'load','errored',$2 FROM generate_series(1,$3) n`,
      [id, new Date().toISOString(), alertLimits.windowRows + 1]
    )
  }
  const loadMs = Date.now() - start
  const rule = await createAlert(
    overloaded,
    {
      ...defaultAlertConfig,
      name: "Oversized window",
      type: "time_window",
      threshold: 1,
    },
    writer
  )
  const durations: number[] = []
  for (let i = 0; i < 3; i++) {
    await writer.query(
      "UPDATE project_alerts SET next_check_at=now() WHERE id=$1",
      [rule.id]
    )
    const start = Date.now()
    await evaluateAlert(writer, rule.id, evaluator)
    durations.push(Date.now() - start)
  }
  const paused = (
    await writer.query(
      "SELECT config,revision,consecutive_failures,last_error FROM project_alerts WHERE id=$1",
      [rule.id]
    )
  ).rows[0]
  expect(paused.config.enabled).toBe(false)
  expect(paused.consecutive_failures).toBe(3)
  expect(paused.last_error).toContain("Automatically paused")
  expect(
    (
      await writer.query(
        "SELECT count(*) FROM alert_deliveries WHERE alert_id=$1",
        [rule.id]
      )
    ).rows[0].count
  ).toBe("0")
  const healthy = await project()
  const healthyRule = await createAlert(
    healthy,
    {
      ...defaultAlertConfig,
      name: "Healthy project",
      filter: "name = 'healthy'",
    },
    writer
  )
  await trace(healthy, "healthy")
  await evaluateAlert(writer, healthyRule.id, evaluator)
  await processAlertDelivery(writer)
  expect(
    (
      await writer.query(
        "SELECT status FROM alert_deliveries WHERE alert_id=$1",
        [healthyRule.id]
      )
    ).rows[0].status
  ).toBe("delivered")
  // Exactly the cap is complete and valid. A foreign project's volume is irrelevant.
  await writer.query("DELETE FROM traces WHERE project_id=$1 AND id=$2", [
    overloaded,
    `${overloaded}-${alertLimits.windowRows + 1}`,
  ])
  const resumed = await updateAlert(
    overloaded,
    rule.id,
    paused.revision,
    rule.config,
    writer
  )
  await evaluateAlert(writer, resumed.id, evaluator)
  const delivered = (
    await writer.query(
      "SELECT payload FROM alert_deliveries WHERE alert_id=$1",
      [rule.id]
    )
  ).rows[0]
  expect(delivered.payload.matchCount).toBe(alertLimits.windowRows)
  expect(
    (
      await writer.query(
        "SELECT consecutive_failures FROM project_alerts WHERE id=$1",
        [rule.id]
      )
    ).rows[0].consecutive_failures
  ).toBe(0)
  const explain = await evaluator.read(healthy, (query) =>
    query("EXPLAIN (FORMAT JSON) SELECT count(*) FROM alert_evaluation_logs")
  )
  const plan = JSON.stringify(explain.rows)
  expect(plan).toContain("Index")
  expect(plan).toContain("project_id")
  proof.load = {
    insertedRows: 2 * (alertLimits.windowRows + 1),
    loadMs,
    rejectedWindowRows: 20001,
    failureDurationsMs: durations,
    autoPausedAfter: 3,
    partialNotifications: 0,
    healthyProjectDelivered: true,
    resumedCompleteCount: 20000,
    indexedScope: true,
  }
}, 60000)

test("oversized event payload is not transferred or discarded silently, and repeated failures pause the rule", async () => {
  const id = await project()
  const rule = await createAlert(
    id,
    { ...defaultAlertConfig, name: "Oversized event" },
    writer
  )
  await writer.query(
    "INSERT INTO alert_events(alert_id,revision,payload) VALUES($1,1,jsonb_build_object('name',repeat('x',$2)))",
    [rule.id, alertLimits.eventBytes + 1]
  )
  for (let i = 0; i < 3; i++) {
    await writer.query(
      "UPDATE project_alerts SET next_check_at=now() WHERE id=$1",
      [rule.id]
    )
    await evaluateAlert(writer, rule.id, evaluator)
    if (i < 2)
      expect(
        (
          await writer.query(
            "SELECT count(*) FROM alert_events WHERE alert_id=$1",
            [rule.id]
          )
        ).rows[0].count
      ).toBe("1")
  }
  const result = (
    await writer.query(
      "SELECT config,last_error FROM project_alerts WHERE id=$1",
      [rule.id]
    )
  ).rows[0]
  expect(result.config.enabled).toBe(false)
  expect(result.last_error).toContain("2 MiB")
  expect(
    (
      await writer.query(
        "SELECT count(*) FROM alert_deliveries WHERE alert_id=$1",
        [rule.id]
      )
    ).rows[0].count
  ).toBe("0")
  proof.eventSize = {
    maxBytes: alertLimits.eventBytes,
    oversizedEventPaused: true,
    falseNotifications: 0,
  }
})

test("randomized typed filters agree with an independent matcher on actual PostgreSQL", async () => {
  let seed = 0x912bef
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  const events = Array.from({ length: 40 }, (_, i) => ({
    id: String(i),
    payload: {
      name: `name-${i % 5}`,
      status: i % 2 ? "errored" : "completed",
      duration_ms: Math.floor(random() * 1000),
      span_attributes: { flag: i % 3 === 0, score: Math.floor(random() * 10) },
    },
  }))
  for (let i = 0; i < 120; i++) {
    const threshold = Math.floor(random() * 1000),
      score = Math.floor(random() * 10),
      flag = random() > 0.5
    const name = `name-${Math.floor(random() * 5)}`
    const filter = `(duration_ms >= ${threshold} AND span_attributes.flag = ${flag}) OR (name = '${name}' AND span_attributes.score < ${score})`
    const expected = events
      .filter(
        ({ payload: p }) =>
          (p.duration_ms >= threshold && p.span_attributes.flag === flag) ||
          (p.name === name && p.span_attributes.score < score)
      )
      .map((e) => e.id)
    expect([
      ...(await evaluator.matchEvents(target.projectId, filter, events)),
    ]).toEqual(expected)
  }
  const poison = "x'; SELECT pg_sleep(99); DROP TABLE traces; --"
  expect([
    ...(await evaluator.matchEvents(
      target.projectId,
      `name = '${poison.replaceAll("'", "''")}'`,
      [{ id: "poison", payload: { name: poison } }]
    )),
  ]).toEqual(["poison"])
  expect(
    (await writer.query("SELECT to_regclass('traces') IS NOT NULL AS exists"))
      .rows[0].exists
  ).toBe(true)
  proof.randomizedDatabaseMatching = {
    filters: 120,
    logsPerFilter: 40,
    parameterizedInjectionMatchedAsText: true,
  }
}, 30000)
