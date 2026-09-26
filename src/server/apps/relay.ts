import { BRIDGE_DELIVERY_GRACE_MS } from "@/src/lib/playground/bridge-retry"
import { canonicalJson } from "@/src/lib/tracer/resource-document"
import type { PromptRunScope } from "@/src/lib/tracer/prompt-overrides"
import { createHash, randomUUID, timingSafeEqual } from "node:crypto"
import { setTimeout as delay } from "node:timers/promises"
import type { Pool } from "pg"
import { z } from "zod"
import { db } from "@/lib/db"
import {
  currentProjectId,
  liveBridge,
  mutate,
  readState,
  type State,
} from "@/src/server/playground/storage"
import type { BridgeJob, BridgeResult } from "@/src/lib/playground/connections"
import {
  definitionSchema,
  type AppDefinition,
} from "@/src/lib/playground/contracts"

export const bridgeSessionSchema = z
  .object({
    id: z.uuid(),
    appIds: z.array(z.string().min(1).max(120)).min(1).max(100),
    revisions: z.record(z.string(), z.number().int().positive()),
    transport: z.literal("relay"),
    token: z.string().min(32).max(256),
    disconnect: z.boolean().optional(),
    resumeToken: z.string().min(32).max(256).optional(),
    protocolVersion: z.literal(2).optional(),
  })
  .strict()
export const bridgeExchangeSchema = z
  .object({
    id: z.uuid(),
    token: z.string().min(32).max(256),
    requestId: z.uuid(),
    sequence: z.number().int().positive().optional(),
    capacity: z.number().int().min(0).max(16).default(1),
    results: z
      .array(
        z.object({
          id: z.uuid(),
          result: z.discriminatedUnion("ok", [
            z
              .object({
                ok: z.literal(true),
                output: z.json(),
                telemetryComplete: z.boolean(),
              })
              .strict(),
            z
              .object({ ok: z.literal(false), error: z.string().max(4000) })
              .strict(),
          ]),
        })
      )
      .max(16)
      .default([]),
  })
  .strict()
const hash = (token: string) => createHash("sha256").update(token).digest("hex")
function definitionHash(app: AppDefinition) {
  // Code edits update provenance/revision, but watched handoff is compatible
  // when the handler's declared contract is unchanged.
  return hash(
    canonicalJson(definitionSchema.omit({ codeProvenance: true }).parse(app))
  )
}
export class BridgeConflict extends Error {}
function authenticated(state: State, id: string, token: string) {
  const bridge = state.bridges.find(
    (item) => item.id === id && item.transport === "relay"
  )
  if (
    !bridge ||
    bridge.token.length !== 64 ||
    !timingSafeEqual(Buffer.from(bridge.token), Buffer.from(hash(token)))
  )
    throw new BridgeConflict("Unknown bridge session. Reconnect the CLI.")
  return bridge
}

export function createRelay(pool: Pool, storage = { readState, mutate }) {
  async function register(input: z.infer<typeof bridgeSessionSchema>) {
    await storage.mutate(async (state, client) => {
      const previous = state.bridges.find((bridge) => bridge.id === input.id)
      if (previous) {
        // A replacement rotates the token, fencing late old polls/disconnects.
        // Retrying an already committed registration authenticates the new token.
        authenticated(
          state,
          input.id,
          previous.token === hash(input.token)
            ? input.token
            : (input.resumeToken ?? input.token)
        )
      } else if (input.resumeToken) {
        throw new BridgeConflict("Reload session expired. Reconnect the CLI.")
      }
      const definitionHashes = Object.fromEntries(
        state.apps
          .filter((app) => input.appIds.includes(app.id))
          .map((app) => [app.id, definitionHash(app)])
      )
      if (input.disconnect) {
        if (previous) {
          state.bridges = state.bridges.filter(
            (bridge) => bridge.id !== input.id
          )
          await client.query(
            "UPDATE app_bridge_job SET result=$3 WHERE project_id=$1 AND bridge_id=$2 AND result IS NULL",
            [
              currentProjectId(),
              input.id,
              JSON.stringify({
                ok: false,
                error: "Local bridge disconnected.",
              }),
            ]
          )
        }
        return
      }
      if (input.resumeToken && previous) {
        if (previous.expiresAt <= Date.now())
          throw new BridgeConflict("Reload session expired. Reconnect the CLI.")
        const active = await client.query(
          "SELECT 1 FROM app_bridge_job WHERE project_id=$1 AND bridge_id=$2 AND claim_id IS NOT NULL AND result IS NULL LIMIT 1",
          [currentProjectId(), input.id]
        )
        if (active.rowCount)
          throw new BridgeConflict(
            "Finish and acknowledge claimed calls before reloading."
          )
        const incompatible = previous.appIds.filter(
          (id) =>
            (previous.revisions[id] !== input.revisions[id] &&
              (!previous.definitionHashes?.[id] ||
                previous.definitionHashes[id] !== definitionHashes[id])) ||
            !input.appIds.includes(id)
        )
        if (incompatible.length)
          await client.query(
            "UPDATE app_bridge_job SET result=$4 WHERE project_id=$1 AND bridge_id=$2 AND app_id=ANY($3::text[]) AND result IS NULL AND claim_id IS NULL",
            [
              currentProjectId(),
              input.id,
              incompatible,
              JSON.stringify({
                ok: false,
                error:
                  "App definition changed before execution. Submit a new call using the current definition.",
              }),
            ]
          )
      }
      for (const id of input.appIds) {
        if (state.connections?.[id]?.type === "webhook")
          throw new BridgeConflict("HTTP apps do not use a local bridge.")
        if (
          !state.apps.some(
            (app) => app.id === id && app.revision === input.revisions[id]
          )
        )
          throw new BridgeConflict(`Sync app ${id} before connecting`)
        if (
          state.bridges.some(
            (bridge) =>
              bridge.id !== input.id &&
              bridge.appIds.includes(id) &&
              bridge.expiresAt > Date.now()
          )
        )
          throw new BridgeConflict(`App ${id} already has a live bridge`)
      }
      state.bridges = [
        ...state.bridges.filter(
          (bridge) => bridge.id !== input.id && bridge.expiresAt > Date.now()
        ),
        {
          id: input.id,
          appIds: input.appIds,
          revisions: input.revisions,
          transport: input.transport,
          url: "",
          token: hash(input.token),
          protocolVersion: input.protocolVersion,
          definitionHashes,
          expiresAt:
            Date.now() +
            (input.protocolVersion === 2 ? BRIDGE_DELIVERY_GRACE_MS : 30000),
          exchangeSequence:
            previous?.token === hash(input.token)
              ? previous.exchangeSequence
              : undefined,
        },
      ]
    })
    return {
      connected: !input.disconnect,
      transport: "relay",
      reload: "session-v1",
      protocolVersion: input.protocolVersion,
    }
  }

  async function exchange(input: z.infer<typeof bridgeExchangeSchema>) {
    // Session ownership and current app revisions are checked before delivering data.
    return storage.mutate(async (state, client) => {
      const projectId = currentProjectId()
      const bridge = authenticated(state, input.id, input.token)
      for (const appId of bridge.appIds) {
        const owner = liveBridge(state, appId)
        if (owner && owner.id !== bridge.id)
          throw new BridgeConflict("Bridge lease was replaced. Reconnect.")
        if (
          !state.apps.some(
            (app) =>
              app.id === appId && app.revision === bridge.revisions[appId]
          )
        )
          throw new BridgeConflict("App changed. Reconnect the CLI.")
      }
      bridge.expiresAt =
        Date.now() +
        (bridge.protocolVersion === 2 ? BRIDGE_DELIVERY_GRACE_MS : 30000)
      // The state row lock serializes claims, receipts, enqueue, resume and disconnect.
      // Idle listeners also produce receipts. Prune a bounded batch on exchanges,
      // not only on invocations, so an idle session cannot grow the ledger forever.
      await client.query(
        `DELETE FROM app_bridge_exchange WHERE (project_id,bridge_id,request_id) IN (
        SELECT project_id,bridge_id,request_id FROM app_bridge_exchange WHERE project_id=$1 AND created_at<now()-interval '1 day' LIMIT 1000
      )`,
        [projectId]
      )
      const requestHash = hash(canonicalJson(input))
      if (bridge.protocolVersion === 2) {
        const receipt = await client.query(
          "SELECT request_hash,reply FROM app_bridge_exchange WHERE project_id=$1 AND bridge_id=$2 AND request_id=$3",
          [projectId, bridge.id, input.requestId]
        )
        if (receipt.rows[0]) {
          if (receipt.rows[0].request_hash !== requestHash)
            throw new BridgeConflict(
              "Exchange ID reused with different content."
            )
          return receipt.rows[0].reply as {
            jobs: BridgeJob[]
            acknowledged: string[]
          }
        }
      }
      const acknowledged: string[] = []
      for (const { id, result } of input.results) {
        const updated = await client.query(
          `UPDATE app_bridge_job SET result=$4 WHERE project_id=$1 AND bridge_id=$2 AND id=$3
           AND claim_id IS NOT NULL AND (result IS NULL OR result=$4::jsonb) RETURNING id`,
          [projectId, bridge.id, id, JSON.stringify(result)]
        )
        // An acknowledgment is proof of durable storage, including late delivery.
        // Recovery can inspect late results; unknown completion never permits replay.
        if (!updated.rowCount)
          throw new BridgeConflict(
            "Unknown, unclaimed or conflicting job result."
          )
        acknowledged.push(id)
      }
      let jobs = await client.query<{ job: BridgeJob }>(
        "SELECT job FROM app_bridge_job WHERE project_id=$1 AND bridge_id=$2 AND claim_id=$3 AND result IS NULL AND deadline>now() ORDER BY created_at",
        [projectId, bridge.id, input.requestId]
      )
      // An empty or completed poll must not claim later arrivals when a delayed
      // duplicate reaches the server. New clients fence every exchange monotonically;
      // token rotation resets the sequence for the next worker.
      const fresh =
        input.sequence === undefined ||
        input.sequence > (bridge.exchangeSequence ?? 0)
      if (input.sequence !== undefined && fresh)
        bridge.exchangeSequence = input.sequence
      if (!jobs.rowCount && input.capacity && fresh)
        jobs = await client.query<{ job: BridgeJob }>(
          `WITH pending AS (SELECT id FROM app_bridge_job WHERE project_id=$1 AND bridge_id=$2 AND claim_id IS NULL AND result IS NULL AND deadline>now()
         ORDER BY created_at LIMIT $4 FOR UPDATE SKIP LOCKED)
         UPDATE app_bridge_job SET claim_id=$3,
           deadline=CASE WHEN $5::boolean THEN now()+((job->>'executionTimeoutMs')::int+$6::int)*interval '1 millisecond' ELSE deadline END,
           job=CASE WHEN $5::boolean THEN jsonb_set(job,'{deadline}',to_jsonb(floor(extract(epoch from now())*1000)+(job->>'executionTimeoutMs')::bigint+$6::int)) ELSE job END WHERE project_id=$1 AND id IN (SELECT id FROM pending) RETURNING job`,
          [
            projectId,
            bridge.id,
            input.requestId,
            Math.min(1, input.capacity),
            bridge.protocolVersion === 2,
            2 * BRIDGE_DELIVERY_GRACE_MS,
          ]
        )
      const reply = { jobs: jobs.rows.map((row) => row.job), acknowledged }
      if (bridge.protocolVersion === 2)
        await client.query(
          "INSERT INTO app_bridge_exchange(project_id,bridge_id,request_id,request_hash,reply) VALUES($1,$2,$3,$4,$5)",
          [
            projectId,
            bridge.id,
            input.requestId,
            requestHash,
            JSON.stringify(reply),
          ]
        )
      return reply
    })
  }
  async function invoke(
    bridgeId: string,
    appId: string,
    input: unknown,
    callId: string,
    traceId?: string,
    timeoutMs = 60000,
    promptScope?: PromptRunScope,
    expectedRevision?: number
  ): Promise<BridgeResult> {
    const projectId = currentProjectId()
    const job = await storage.mutate(async (state, client) => {
      const bridge = liveBridge(state, appId)
      if (!bridge || bridge.id !== bridgeId)
        throw new Error("App is offline. Reconnect the local bridge.")
      if (
        expectedRevision !== undefined &&
        bridge.revisions[appId] !== expectedRevision
      )
        throw new BridgeConflict("App definition changed before execution.")
      const job: BridgeJob = {
        id: randomUUID(),
        appId,
        input,
        callId,
        traceId,
        promptScope,
        deadline:
          Date.now() +
          (bridge.protocolVersion === 2 ? BRIDGE_DELIVERY_GRACE_MS : timeoutMs),
        ...(bridge.protocolVersion === 2
          ? { executionTimeoutMs: timeoutMs }
          : {}),
      }
      if (Buffer.byteLength(JSON.stringify(job)) > 768 * 1024)
        throw new Error("Bridge input exceeds 768 KiB.")
      const inserted = await client.query<{ job: BridgeJob }>(
        `INSERT INTO app_bridge_job(project_id,id,bridge_id,app_id,call_id,job,deadline) VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(project_id,call_id) DO NOTHING RETURNING job`,
        [
          projectId,
          job.id,
          bridgeId,
          appId,
          callId,
          JSON.stringify(job),
          new Date(job.deadline),
        ]
      )
      if (!inserted.rowCount)
        throw new Error(
          "Invocation already dispatched. Inspect its existing run instead of repeating it."
        )
      return job
    })
    // Bounded retention; results/traces belong to the evaluation, not this transport mailbox.
    await pool.query(
      "DELETE FROM app_bridge_job WHERE project_id=$1 AND deadline<now()-interval '1 day'",
      [projectId]
    )
    for (;;) {
      const result = await pool.query<{
        result: BridgeResult | null
        deadline: Date
        claim_id: string | null
      }>(
        "SELECT result,deadline,claim_id FROM app_bridge_job WHERE project_id=$1 AND id=$2",
        [projectId, job.id]
      )
      if (result.rows[0]?.result) return result.rows[0].result
      if (!result.rows[0] || result.rows[0].deadline.getTime() <= Date.now()) {
        if (result.rows[0] && !result.rows[0].claim_id)
          throw new Error(
            "Local bridge did not receive the invocation before the dispatch deadline."
          )
        break
      }
      await delay(250)
    }
    throw new Error(
      "Local handler timed out. It may still be running; Datool will not execute it again automatically."
    )
  }
  return { register, exchange, invoke }
}
export const relay = createRelay(db)
