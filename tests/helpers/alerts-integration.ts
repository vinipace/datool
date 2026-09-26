import { GET as GET_NOTIFICATIONS } from "../../app/api/projects/[projectId]/alerts/[alertId]/notifications/route"
import { closeAlertEvaluator } from "../../src/server/alerts/evaluator"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db, analyticsDb } from "../../lib/db"
import {
  createAlert,
  updateAlert,
  listAlerts,
} from "../../src/server/alerts/service"
import {
  evaluateAlert,
  processAlertDelivery,
  runAlertTick,
} from "../../src/server/alerts/worker"
import { createTracerDatabase } from "../../src/server/tracer/db"
import { persistEvent } from "../../src/server/ingestion/persist"
import { GET, POST } from "../../app/api/projects/[projectId]/alerts/route"
import {
  PATCH,
  DELETE,
  GET as GET_ALERT,
} from "../../app/api/projects/[projectId]/alerts/[alertId]/route"
import { defaultAlertConfig } from "../../src/lib/alerts/contracts"

const received: { key: string; payload: { id: string } }[] = []
let fail = true
const server = createServer(async (request, response) => {
  let body = ""
  for await (const chunk of request) body += chunk
  received.push({
    key: String(request.headers["idempotency-key"]),
    payload: JSON.parse(body),
  })
  response.writeHead(fail ? 503 : 204)
  response.end()
})
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
const port = (server.address() as { port: number }).port

try {
  const context = await getAuth().$context
  const owner = await context.internalAdapter.createUser(
    { name: "Alerts owner", email: "alerts@example.test", emailVerified: true },
    { method: "oauth" }
  )
  const session = await context.internalAdapter.createSession(owner.id)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  const headers = {
    cookie,
    origin: "http://localhost:3000",
    "content-type": "application/json",
  }
  const org = await getAuth().api.createOrganization({
    headers: new Headers(headers),
    body: { name: "Alerts", slug: "alerts" },
  })
  assert(org)
  const projectId = crypto.randomUUID()
  const foreign = crypto.randomUUID()
  await db.query(
    "INSERT INTO organization(id,name,slug,\"createdAt\") VALUES($1,'Other','other',now())",
    [foreign]
  )
  await db.query(
    "INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Alerts','alerts'),($3,$3,'Other','other')",
    [projectId, org.id, foreign]
  )
  const request = (method: string, body?: unknown, extra = headers) =>
    new Request(`http://localhost:3000/api/projects/${projectId}/alerts`, {
      method,
      headers: extra,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
  const params = { params: Promise.resolve({ projectId }) }
  const config = {
    ...defaultAlertConfig,
    name: "Errored traces",
    filter: "resource = 'trace' AND status = 'errored'",
    action: "webhook",
    webhookUrl: `http://127.0.0.1:${port}/alerts`,
  }
  assert.equal(
    (await GET(new Request("http://localhost/"), params)).status,
    401
  )
  assert.equal(
    (
      await GET(request("GET"), {
        params: Promise.resolve({ projectId: foreign }),
      })
    ).status,
    403
  )
  assert.equal(
    (
      await POST(
        request("POST", config, { ...headers, origin: "https://evil.test" }),
        params
      )
    ).status,
    403
  )
  assert.equal(
    (
      await POST(
        request("POST", { ...config, filter: "name = 'a'; SELECT 1" }),
        params
      )
    ).status,
    400
  )
  const created = await POST(request("POST", config), params)
  assert.equal(created.status, 201)
  const rule = (await created.json()).alert
  assert.equal((await listAlerts(projectId)).alerts[0].id, rule.id)
  const scoped = { params: Promise.resolve({ projectId, alertId: rule.id }) }
  assert.equal(
    (await PATCH(request("PATCH", { revision: 999, config }), scoped)).status,
    409
  )
  const foreignScoped = {
    params: Promise.resolve({ projectId: foreign, alertId: rule.id }),
  }
  assert.equal((await DELETE(request("DELETE"), foreignScoped)).status, 403)
  await db.query("UPDATE member SET role='member' WHERE \"userId\"=$1", [
    owner.id,
  ])
  assert.equal((await GET(request("GET"), params)).status, 200)
  assert.equal((await POST(request("POST", config), params)).status, 403)
  assert.equal(
    (await PATCH(request("PATCH", { revision: 1, config }), scoped)).status,
    403
  )
  assert.equal((await DELETE(request("DELETE"), scoped)).status, 403)
  await db.query("UPDATE member SET role='owner' WHERE \"userId\"=$1", [
    owner.id,
  ])

  const tracer = createTracerDatabase(undefined, { projectId })
  const traceId = crypto.randomUUID()
  const startedAt = new Date().toISOString()
  const event = {
    id: crypto.randomUUID(),
    previousId: null,
    method: "POST" as const,
    path: "/api/traces",
    body: {
      id: traceId,
      name: "Nonmatching request",
      status: "running",
      startedAt,
    },
  }
  await persistEvent(tracer, event)
  await runAlertTick(db)
  assert.equal((await listAlerts(projectId)).deliveries.length, 0)
  const patch = {
    id: crypto.randomUUID(),
    previousId: event.id,
    method: "PATCH" as const,
    path: `/api/traces/${traceId}`,
    body: { status: "errored", endedAt: new Date().toISOString() },
  }
  await persistEvent(tracer, patch)
  await persistEvent(tracer, patch) // Retried SDK event must not produce another queue entry.
  await Promise.all([evaluateAlert(db, rule.id), evaluateAlert(db, rule.id)])
  assert.equal((await listAlerts(projectId)).deliveries.length, 1)
  await Promise.all([processAlertDelivery(db), processAlertDelivery(db)])
  assert.equal(received.length, 1)
  let delivery = (await listAlerts(projectId)).deliveries[0]
  assert.equal(delivery.status, "pending")
  assert.equal(delivery.attempts, 1)
  assert.equal(delivery.lastError, "Webhook returned HTTP 503.")
  fail = false
  await db.query(
    "UPDATE alert_deliveries SET next_attempt_at=now() WHERE id=$1",
    [delivery.id]
  )
  await processAlertDelivery(db)
  delivery = (await listAlerts(projectId)).deliveries[0]
  assert.equal(delivery.status, "delivered")
  assert.equal(delivery.attempts, 2)
  assert.equal(received[0].key, received[1].key)
  assert.equal(received[1].key, delivery.id)
  assert.equal(received[1].payload.id, delivery.id)

  await persistEvent(tracer, {
    ...event,
    id: crypto.randomUUID(),
    body: {
      id: crypto.randomUUID(),
      name: "Suppressed by cooldown",
      status: "errored",
      startedAt,
    },
  })
  await runAlertTick(db)
  assert.equal((await listAlerts(projectId)).deliveries.length, 1)
  // The outbox and the triggering write commit or roll back together.
  const transaction = await db.connect()
  await transaction.query("BEGIN")
  await transaction.query("UPDATE traces SET name='Rolled back' WHERE id=$1", [
    traceId,
  ])
  await transaction.query("ROLLBACK")
  transaction.release()
  assert.equal(
    (await db.query("SELECT count(*) FROM alert_events")).rows[0].count,
    "0"
  )

  const timeRule = await createAlert(projectId, {
    ...defaultAlertConfig,
    name: "Error burst",
    type: "time_window",
    filter: "resource = 'trace' AND status = 'errored'",
    threshold: 2,
  })
  await Promise.all([
    evaluateAlert(db, timeRule.id),
    evaluateAlert(db, timeRule.id),
  ])
  await processAlertDelivery(db)
  const burst = (await listAlerts(projectId)).deliveries.find(
    (item) => item.alertId === timeRule.id
  )!
  assert.equal(burst.status, "delivered")
  assert.equal(burst.payload.matchCount, 2)
  // Foreign and old rows cannot satisfy the current project's threshold.
  const isolatedRule = await createAlert(projectId, {
    ...defaultAlertConfig,
    name: "Isolated count",
    type: "time_window",
    filter: "name = 'outside'",
    threshold: 1,
  })
  await db.query(
    "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES($1,$2,'outside','test','errored',$3),($4,$5,'outside','test','errored','2020-01-01T00:00:00Z')",
    [crypto.randomUUID(), foreign, startedAt, crypto.randomUUID(), projectId]
  )
  await evaluateAlert(db, isolatedRule.id)
  assert(
    !(await listAlerts(projectId)).deliveries.some(
      (item) => item.alertId === isolatedRule.id
    )
  )

  const spanRule = await createAlert(projectId, {
    ...defaultAlertConfig,
    name: "Slow LLM",
    filter:
      "kind = 'llm' AND duration_ms > 5000 AND span_attributes.gen_ai.request.model = 'test-model'",
  })
  await persistEvent(tracer, {
    id: crypto.randomUUID(),
    previousId: null,
    method: "POST",
    path: `/api/traces/${traceId}/spans`,
    body: {
      id: crypto.randomUUID(),
      name: "LLM",
      kind: "llm",
      status: "completed",
      startedAt: new Date(Date.now() - 7000).toISOString(),
      endedAt: new Date().toISOString(),
      attributes: { "gen_ai.request.model": "test-model" },
    },
  })
  await runAlertTick(db)
  assert(
    (await listAlerts(projectId)).deliveries.some(
      (item) => item.alertId === spanRule.id && item.status === "delivered"
    )
  )

  const paused = await updateAlert(projectId, rule.id, rule.revision, {
    ...config,
    enabled: false,
  })
  await db.query(
    "UPDATE project_alerts SET last_notified_at=NULL WHERE id=$1",
    [rule.id]
  )
  await persistEvent(tracer, {
    ...event,
    id: crypto.randomUUID(),
    body: {
      id: crypto.randomUUID(),
      name: "Paused",
      status: "errored",
      startedAt,
    },
  })
  await runAlertTick(db)
  assert.equal(
    (await listAlerts(projectId)).deliveries.filter(
      (item) => item.alertId === rule.id
    ).length,
    1
  )
  await updateAlert(projectId, rule.id, paused.revision, config)
  await persistEvent(tracer, {
    ...event,
    id: crypto.randomUUID(),
    body: {
      id: crypto.randomUUID(),
      name: "Resumed",
      status: "errored",
      startedAt,
    },
  })
  fail = true
  await evaluateAlert(db, rule.id)
  for (let i = 0; i < 5; i++) {
    await db.query(
      "UPDATE alert_deliveries SET next_attempt_at=now() WHERE status='pending'"
    )
    await processAlertDelivery(db)
  }
  const failed = (await listAlerts(projectId)).deliveries.find(
    (item) => item.alertId === rule.id && item.status === "failed"
  )!
  assert.equal(failed.attempts, 5)
  const deleted = await DELETE(request("DELETE"), scoped)
  assert.equal(deleted.status, 200)
  assert.equal(
    (await listAlerts(projectId)).alerts.some((item) => item.id === rule.id),
    false
  )
  // Interleave two real commits around an evaluation. A lower sequence ID may
  // become visible after the worker reads a later one; it must remain queued.
  const raceRule = await createAlert(projectId, {
    ...defaultAlertConfig,
    name: "Concurrent arrivals",
    filter: "name LIKE 'race-%'",
  })
  const gateKey = Math.floor(Math.random() * 1000000000) + 1
  await db.query(`CREATE FUNCTION test_alert_gate() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.alert_id = '${raceRule.id}' THEN PERFORM pg_advisory_xact_lock(${gateKey}); END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER test_alert_gate BEFORE INSERT ON alert_deliveries FOR EACH ROW EXECUTE FUNCTION test_alert_gate()`)
  const late = await db.connect()
  const gate = await db.connect()
  let evaluating: Promise<void> | undefined
  try {
    await late.query("BEGIN")
    await late.query(
      "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES($1,$2,'race-late','test','errored',$3)",
      [crypto.randomUUID(), projectId, startedAt]
    )
    await db.query(
      "INSERT INTO traces(id,project_id,name,operation,status,started_at) VALUES($1,$2,'race-visible','test','errored',$3)",
      [crypto.randomUUID(), projectId, startedAt]
    )
    await gate.query("SELECT pg_advisory_lock($1)", [gateKey])
    evaluating = evaluateAlert(db, raceRule.id)
    const deadline = Date.now() + 5000
    while (
      !(
        await db.query(
          "SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1::oid AND NOT granted",
          [gateKey]
        )
      ).rowCount
    ) {
      assert(
        Date.now() < deadline,
        "Evaluation should reach the delivery gate without blocking ingestion"
      )
      await new Promise((done) => setTimeout(done, 10))
    }
    await late.query("COMMIT")
    await gate.query("SELECT pg_advisory_unlock($1)", [gateKey])
    await evaluating
    const remaining = await db.query(
      "SELECT payload->>'name' AS name FROM alert_events WHERE alert_id=$1",
      [raceRule.id]
    )
    assert.deepEqual(remaining.rows, [{ name: "race-late" }])
    await evaluateAlert(db, raceRule.id)
    assert.equal(
      (
        await db.query("SELECT 1 FROM alert_events WHERE alert_id=$1", [
          raceRule.id,
        ])
      ).rowCount,
      0
    )
  } finally {
    await late.query("ROLLBACK")
    await gate.query("SELECT pg_advisory_unlock($1)", [gateKey])
    await evaluating
    late.release()
    gate.release()
    await db.query(
      "DROP TRIGGER test_alert_gate ON alert_deliveries; DROP FUNCTION test_alert_gate()"
    )
  }
  // Detail links and history are independently project scoped. Filtering is
  // applied before cursor pagination, including older rows beyond the first 50.
  const historyRule = await createAlert(projectId, {
    ...defaultAlertConfig,
    name: "Paged history",
  })
  const historyParams = {
    params: Promise.resolve({ projectId, alertId: historyRule.id }),
  }
  const foreignRule = await createAlert(foreign, {
    ...defaultAlertConfig,
    name: "Foreign history",
  })
  await db.query(
    `INSERT INTO alert_deliveries(id,project_id,alert_id,alert_name,action,payload,status,attempts,created_at)
    SELECT 'history-'||lpad(n::text,3,'0'),$1,$2,'Paged history','in_app',jsonb_build_object('matchCount',n),
      CASE WHEN n%2=0 THEN 'failed' ELSE 'delivered' END,1,'2026-09-17T10:00:00Z'::timestamptz
    FROM generate_series(1,130) n`,
    [projectId, historyRule.id]
  )
  await db.query(
    `INSERT INTO alert_deliveries(id,project_id,alert_id,alert_name,action,payload) VALUES('foreign-history',$1,$2,'Foreign history','in_app','{"matchCount":999}')`,
    [foreign, foreignRule.id]
  )
  assert.equal((await GET_ALERT(request("GET"), historyParams)).status, 200)
  const notificationRequest = (query = "") =>
    new Request(
      `http://localhost:3000/api/projects/${projectId}/alerts/${historyRule.id}/notifications?${query}`,
      { headers }
    )
  const firstResponse = await GET_NOTIFICATIONS(
    notificationRequest("includeTotal=true"),
    historyParams
  )
  assert.equal(firstResponse.status, 200, await firstResponse.clone().text())
  const firstPage = await firstResponse.json()
  assert.equal(firstPage.total, 130)
  assert.equal(firstPage.items.length, 50)
  const secondPage = await (
    await GET_NOTIFICATIONS(
      notificationRequest(`cursor=${firstPage.nextCursor}`),
      historyParams
    )
  ).json()
  const lastPage = await (
    await GET_NOTIFICATIONS(
      notificationRequest(`cursor=${secondPage.nextCursor}`),
      historyParams
    )
  ).json()
  assert.equal(lastPage.items.length, 30)
  assert.equal(lastPage.nextCursor, null)
  assert.equal(
    new Set(
      [...firstPage.items, ...secondPage.items, ...lastPage.items].map(
        (item) => item.id
      )
    ).size,
    130
  )
  const filtered = await (
    await GET_NOTIFICATIONS(
      notificationRequest(
        new URLSearchParams({
          filter: "status = failed matchCount >= 100",
          includeTotal: "true",
        }).toString()
      ),
      historyParams
    )
  ).json()
  assert.equal(filtered.total, 16)
  assert(
    filtered.items.every(
      (item: { status: string; matchCount: number }) =>
        item.status === "failed" && item.matchCount >= 100
    )
  )
  assert.equal(
    (
      await GET_NOTIFICATIONS(
        notificationRequest("cursor=foreign-history"),
        historyParams
      )
    ).status,
    400
  )
  assert.equal(
    (
      await GET_NOTIFICATIONS(
        notificationRequest("filter=project_id%20%3D%20foreign"),
        historyParams
      )
    ).status,
    400
  )
  assert.equal(
    (
      await GET_NOTIFICATIONS(
        notificationRequest("limit=1000000"),
        historyParams
      )
    ).status,
    400
  )
  assert.equal(
    (
      await GET_ALERT(request("GET"), {
        params: Promise.resolve({ projectId, alertId: foreignRule.id }),
      })
    ).status,
    404
  )
  assert.equal(
    (
      await GET_NOTIFICATIONS(notificationRequest(), {
        params: Promise.resolve({ projectId, alertId: foreignRule.id }),
      })
    ).status,
    404
  )
  assert.equal(
    (await GET_NOTIFICATIONS(new Request("http://localhost/"), historyParams))
      .status,
    401
  )
  await db.query(`UPDATE member SET role='member' WHERE "userId"=$1`, [
    owner.id,
  ])
  assert.equal((await GET_ALERT(request("GET"), historyParams)).status, 200)
  assert.equal(
    (await GET_NOTIFICATIONS(notificationRequest(), historyParams)).status,
    200
  )
  assert.equal(
    (await PATCH(request("PATCH", { revision: 1, config }), historyParams))
      .status,
    403
  )
  await db.query(`UPDATE member SET role='owner' WHERE "userId"=$1`, [owner.id])
  // The HTTP limiter includes rejected edits and returns an actionable retry.
  await db.query(
    "INSERT INTO alert_project_budgets(project_id,kind,window_start,used) VALUES($1,'mutation',date_trunc('minute',clock_timestamp()),29) ON CONFLICT(project_id,kind) DO UPDATE SET window_start=excluded.window_start,used=29",
    [projectId]
  )
  assert.equal(
    (await POST(request("POST", { ...config, filter: "SELECT 1" }), params))
      .status,
    400
  )
  const limited = await POST(request("POST", config), params)
  assert.equal(limited.status, 429)
  assert.equal(limited.headers.get("Retry-After"), "60")
  assert.equal((await limited.json()).error.code, "RATE_LIMITED")
  assert.equal((await GET(request("GET"), params)).status, 200)
  console.log(
    "PASS alerts end-to-end integration: API authorization, ingestion transaction, retries, idempotency, cooldown, time windows, spans, pause/resume and delete"
  )
} finally {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  )
  await closeAlertEvaluator()
  await db.end()
  await analyticsDb.end()
}
