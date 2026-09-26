import assert from "node:assert/strict"
import { expect, test } from "bun:test"
import { Pool } from "pg"
import { ExecutionCreditStore } from "../src/server/execution-credits/ledger"
import {
  managedModelFetch,
  modelUsageCharge,
  MODEL_RESERVATION,
} from "../src/server/execution-credits/model"
import { sandboxExecutionOrder } from "../src/lib/sandbox-providers"
import { DATOOL_SCORER_MODEL } from "../src/lib/execution-credits"
import { paidInvoicePeriod } from "../src/server/execution-credits/grants"
import {
  runManagedSandbox,
  SANDBOX_RESERVATION,
} from "../src/server/execution-credits/sandbox"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"
import type Stripe from "stripe"

test("paid invoice policy excludes trials, prorations, duplicate periods, and unrelated prices", () => {
  const before = { ...process.env }
  Object.assign(process.env, {
    DATOOL_BILLING_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    STRIPE_CORE_PRICE_ID: "price_core",
    STRIPE_PRO_PRICE_ID: "price_pro",
  })
  try {
    const invoice = {
      id: "invoice",
      status: "paid",
      amount_paid: 100,
      billing_reason: "subscription_cycle",
      parent: { subscription_details: { subscription: "sub" } },
      lines: {
        has_more: false,
        data: [
          {
            amount: 100,
            pricing: { price_details: { price: "price_core" } },
            parent: { subscription_item_details: { proration: false } },
            period: { start: 10, end: 100 },
          },
        ],
      },
    } as unknown as Stripe.Invoice
    expect(
      paidInvoicePeriod(invoice, "org", "sub", "price_core", 100)?.plan
    ).toBe("core")
    for (const override of [
      { status: "open" },
      { amount_paid: 0 },
      { billing_reason: "subscription_update" },
    ])
      expect(
        paidInvoicePeriod(
          { ...invoice, ...override } as Stripe.Invoice,
          "org",
          "sub",
          "price_core",
          100
        )
      ).toBeNull()
    expect(
      paidInvoicePeriod(invoice, "org", "other", "price_core", 100)
    ).toBeNull()
    expect(
      paidInvoicePeriod(invoice, "org", "sub", "price_core", 101)
    ).toBeNull()
    expect(paidInvoicePeriod(invoice, "org", "sub", "other", 100)).toBeNull()
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in before)) delete process.env[key]
    Object.assign(process.env, before)
  }
})

test("token charges include cached input and total output; missing or malformed usage remains unpriced", () => {
  expect(
    modelUsageCharge({
      usage: {
        input_tokens: 2000,
        input_tokens_details: { cached_tokens: 1000 },
        output_tokens: 300,
      },
    })?.amount
  ).toBe(260000)
  expect(
    modelUsageCharge({
      usage: {
        prompt_tokens: 2000,
        completion_tokens: 300,
        completion_tokens_details: { reasoning_tokens: 100 },
      },
    })?.amount
  ).toBe(350000)
  expect(
    modelUsageCharge({
      usage: {
        input_tokens: 1,
        output_tokens: 2,
        input_tokens_details: { cached_tokens: 3 },
      },
    })
  ).toBeNull()
  expect(modelUsageCharge({})).toBeNull()
})

test("funding sources never become automatic sandbox fallbacks", () => {
  expect(sandboxExecutionOrder(["datool", "modal", "local"], "datool")).toEqual(
    ["datool"]
  )
  expect(sandboxExecutionOrder(["datool", "modal", "local"], "modal")).toEqual([
    "modal",
    "local",
  ])
})

test("shared ledger serializes reservations, preserves uncertain calls, isolates tenants, and settles once", async () => {
  const target = await createIsolatedPostgres()
  const pool = new Pool({ connectionString: target.databaseUrl })
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const store = new ExecutionCreditStore(pool)
    const otherProject = crypto.randomUUID()
    await pool.query(
      `INSERT INTO project(id,organization_id,name,slug) VALUES($1,$2,'Other project','other')`,
      [otherProject, target.organizationId]
    )
    await pool.query(
      `INSERT INTO organization_billing(organization_id,subscription_id,price_id,status,access_until,checkout_attempt_id) VALUES($1,'sub','price_core','active',now()+interval '30 days','attempt')`,
      [target.organizationId]
    )
    const grant = {
      organizationId: target.organizationId,
      subscriptionId: "sub",
      invoiceId: "invoice",
      start: new Date(Date.now() - 1000),
      end: new Date(Date.now() + 30 * 86400000),
      plan: "core" as const,
    }
    await Promise.all(Array.from({ length: 5 }, () => store.grant(grant)))
    expect((await store.usage(target.organizationId)).allowance).toBe(5)
    const reservations = await Promise.allSettled(
      [target.projectId, otherProject, target.projectId, otherProject].map(
        (project) => store.reserve(project, "model", 2_000_000_000, "test")
      )
    )
    const ids = reservations.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : []
    )
    expect(ids).toHaveLength(2)
    expect((await store.usage(target.organizationId)).reserved).toBe(4)
    await assert.rejects(store.reserve("unknown-project", "model", 1, "test"))
    await Promise.all([
      store.settle(ids[0], 500000, "request", {}),
      store.settle(ids[0], 500000, "request", {}),
    ])
    await assert.rejects(
      store.settle(ids[0], 600000, "request", {}),
      /Conflicting/
    )
    await store.settle(ids[1], 0, null, { rejected: true })
    expect((await store.usage(target.organizationId)).used).toBe(0.0005)
    expect((await store.usage(target.organizationId)).reserved).toBe(0)
    expect(
      (
        await pool.query(
          `SELECT count(*) FROM execution_credit_ledger WHERE kind='grant'`
        )
      ).rows[0].count
    ).toBe("1")

    const operations: string[] = []
    let calls = 0
    const managed = managedModelFetch(
      target.projectId,
      operations,
      (async (_url, init) => {
        calls++
        const body = JSON.parse(String(init?.body))
        expect(body.model).toBe(DATOOL_SCORER_MODEL)
        expect(body.max_output_tokens).toBe(4096)
        expect(body.service_tier).toBe("default")
        return Response.json({
          id: "response",
          usage: { input_tokens: 2000, output_tokens: 300 },
          status: "completed",
        })
      }) as typeof fetch,
      store
    )
    const request = {
      method: "POST",
      body: JSON.stringify({
        model: DATOOL_SCORER_MODEL,
        input: "evidence",
        service_tier: "priority",
        max_output_tokens: 999999,
      }),
    }
    await managed("https://api.openai.com/v1/responses", request)
    expect((await store.usage(target.organizationId)).used).toBe(0.00085)
    expect(operations).toHaveLength(1)
    await managed("https://api.openai.com/v1/responses", {
      ...request,
      body: JSON.stringify({ model: "other" }),
    })
    expect(calls).toBe(1)
    const job = {
      language: "javascript" as const,
      payload: "{}",
      timeoutMs: 1000,
    }
    const sandbox = await runManagedSandbox(target.projectId, job, {
      credits: store,
      assertProject: async () => {},
      execute: async (credentials, job) => {
        expect(credentials.provider).toBe("modal")
        await job.onModalCreated?.("sandbox-completed")
        await job.onModalUsage?.({
          sandboxId: "sandbox-completed",
          allocatedMs: 1000,
        })
        return { score: 1, passed: true }
      },
    })
    expect(sandbox.score).toBe(1)
    expect(sandbox.metadata?.fundingSource).toBe("datool")
    const failedSandbox = await runManagedSandbox(target.projectId, job, {
      credits: store,
      assertProject: async () => {},
      execute: async (_credentials, job) => {
        await job.onModalCreated?.("sandbox-uncertain")
        throw new Error("Termination not confirmed")
      },
    })
    expect((await store.usage(target.organizationId)).reserved).toBe(
      SANDBOX_RESERVATION / 1e9
    )
    const pendingSandbox = failedSandbox.metadata?.creditOperations as string[]
    expect(pendingSandbox).toHaveLength(1)
    const pendingEvidence = (
      await pool.query(
        "SELECT provider_id FROM execution_credit_operation WHERE id=$1",
        [pendingSandbox[0]]
      )
    ).rows[0]
    expect(pendingEvidence.provider_id).toBe("sandbox-uncertain")
    await store.settle(pendingSandbox[0], 0, "sandbox-uncertain", {
      verifiedUnbilled: true,
    })
    const removedProjectUsage=await store.reserve(otherProject,"model",100,"test")
    await store.settle(removedProjectUsage,100,"old-project",{})
    await pool.query("DELETE FROM project WHERE id=$1",[otherProject])
    expect((await store.usage(target.organizationId)).projects.some(project=>project.id===otherProject && project.name==="Deleted project")).toBe(true)
    const uncertain = managedModelFetch(
      target.projectId,
      operations,
      (async () => {
        throw new Error("timeout after acceptance")
      }) as typeof fetch,
      store
    )
    await assert.rejects(
      uncertain("https://api.openai.com/v1/responses", request)
    )
    expect((await store.usage(target.organizationId)).reserved).toBe(
      MODEL_RESERVATION / 1e9
    )
    await pool.query(
      `UPDATE organization_billing SET status='past_due' WHERE organization_id=$1`,
      [target.organizationId]
    )
    const denied = await managed("https://api.openai.com/v1/responses", request)
    expect(denied.status).toBe(402)
    expect(calls).toBe(1)
    const quotaSandbox = await runManagedSandbox(target.projectId, job, {
      credits: store,
      assertProject: async () => {},
      execute: async () => {
        throw new Error("Must not dispatch")
      },
    })
    expect(quotaSandbox.metadata?.runtimeDiagnostic).toEqual({
      category: "quota",
    })
    // A new paid period gets its own allowance; late usage stays on the old one.
    await pool.query(
      "UPDATE execution_credit_period SET period_start=now()-interval '1 month',period_end=now()-interval '1 second'"
    )
    await store.grant({
      ...grant,
      invoiceId: "renewal",
      start: new Date(),
      plan: "pro",
    })
    expect((await store.usage(target.organizationId)).allowance).toBe(25)
    await store.settle(operations[1], 100, "late-request", { reconciled: true })
    expect((await store.usage(target.organizationId)).reserved).toBe(0)
    expect((await store.usage(target.organizationId)).used).toBe(0)
    expect(
      (
        await pool.query(
          "SELECT reserved FROM execution_credit_period WHERE invoice_id='invoice'"
        )
      ).rows[0].reserved
    ).toBe("0")
  } finally {
    await pool.end()
    await target.close()
  }
}, 120000)

test("managed scoring works through persisted evaluation and authorized usage APIs without project keys", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const { execFile } = await import("node:child_process")
    const { promisify } = await import("node:util")
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/managed-execution-integration.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          TEST_ORGANIZATION_ID: target.organizationId,
          TEST_PROJECT_ID: target.projectId,
          TEST_OWNER_ID: target.ownerId,
          BETTER_AUTH_SECRET:
            "managed-test-secret-at-least-thirty-two-characters",
          BETTER_AUTH_URL: "http://localhost:3000",
          DATOOL_BILLING_ENABLED: "true",
          DATOOL_MANAGED_EXECUTION_ENABLED: "true",
          DATOOL_SCORER_OPENAI_API_KEY: "managed-test-key",
          STRIPE_SECRET_KEY: "sk_test_fixture",
          STRIPE_WEBHOOK_SECRET: "whsec_fixture",
          STRIPE_CORE_PRICE_ID: "price_core",
          STRIPE_PRO_PRICE_ID: "price_pro",
        },
        timeout: 60000,
      }
    )
    expect(stdout).toContain("PASS paid grant")
  } finally {
    await target.close()
  }
}, 120000)
