import assert from "node:assert/strict"
import { makeSignature } from "better-auth/crypto"
import { db, analyticsDb } from "../../lib/db"
import { getAuth } from "../../lib/auth"
import { getStripe } from "../../src/server/billing/config"
import { getBilling } from "../../src/server/billing/store"
import { executionCredits } from "../../src/server/execution-credits/ledger"
import { getProjectProviders } from "../../src/server/model-providers/store"
import { GET as getUsage } from "../../app/api/organizations/[organizationId]/usage/route"
import { GET as modelCatalog } from "../../app/api/projects/[projectId]/providers/models/route"
import { defaultScorer } from "../../src/lib/tracer/scorers"
import { defaultLibraryScorer } from "../../src/lib/tracer/scorer-libraries"
import { runTracerEffect as run } from "../../src/server/tracer/effect"
import { TracerService } from "../../src/server/tracer/service"
import { createTracerDatabase } from "../../src/server/tracer/db"
import { resolveJudgeOptions } from "../../src/server/model-providers/judge"
import type Stripe from "stripe"

const organizationId = process.env.TEST_ORGANIZATION_ID!
const projectId = process.env.TEST_PROJECT_ID!
const ownerId = process.env.TEST_OWNER_ID!
const originalFetch = globalThis.fetch
try {
  const now = Math.floor(Date.now() / 1000)
  const stripe = getStripe()
  const subscriptions = [
    {
      id: "sub_managed",
      customer: "cus_managed",
      status: "active",
      created: now,
      items: {
        data: [
          {
            price: { id: "price_core" },
            current_period_start: now - 60,
            current_period_end: now + 86400,
          },
        ],
      },
    },
  ] as Stripe.Subscription[]
  stripe.subscriptions.list = (() =>
    Object.assign(Promise.resolve({ data: subscriptions }), {
      async *[Symbol.asyncIterator]() {
        yield* subscriptions
      },
    })) as unknown as typeof stripe.subscriptions.list
  const invoice = {
    id: "in_managed",
    status: "paid",
    amount_paid: 14824,
    billing_reason: "subscription_cycle",
    parent: { subscription_details: { subscription: "sub_managed" } },
    lines: {
      has_more: false,
      data: [
        {
          amount: 14824,
          pricing: { price_details: { price: "price_core" } },
          parent: { subscription_item_details: { proration: false } },
          period: { start: now - 60, end: now + 86400 },
        },
      ],
    },
  } as unknown as Stripe.Invoice
  stripe.invoices.list = (() =>
    Object.assign(Promise.resolve({ data: [invoice] }), {
      async *[Symbol.asyncIterator]() {
        yield invoice
      },
    })) as unknown as typeof stripe.invoices.list
  await db.query(
    `INSERT INTO organization_billing(organization_id,customer_id,checkout_attempt_id) VALUES($1,'cus_managed','attempt')`,
    [organizationId]
  )
  await getBilling(organizationId, true)
  await getBilling(organizationId, true)
  assert.equal((await executionCredits.usage(organizationId)).allowance, 5)
  assert(
    (await getProjectProviders(projectId)).every(
      (provider) => !provider.configured
    ),
    "No customer keys are configured"
  )
  let calls = 0
  globalThis.fetch = (async (input, init) => {
    if (String(input) === "https://api.openai.com/v1/responses") {
      calls++
      assert.equal(
        new Headers(init?.headers).get("Authorization"),
        "Bearer managed-test-key"
      )
      const body = JSON.parse(String(init?.body))
      assert.equal(body.model, "gpt-6-luna")
      if (body.tools?.length)
        return Response.json({
          id: `library_${calls}`,
          status: "completed",
          model: "gpt-6-luna",
          output: [
            {
              type: "function_call",
              name: "select_choice",
              call_id: "choice",
              arguments: JSON.stringify({
                choice: "C",
                reasons: "Matches evidence",
              }),
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        })
      return Response.json(
        {
          id: `resp_${calls}`,
          status: "completed",
          model: "gpt-6-luna",
          output: [
            {
              type: "message",
              role: "assistant",
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    choice: "Pass",
                    reason: "Matches evidence",
                  }),
                },
              ],
            },
          ],
          usage: { input_tokens: 100, output_tokens: 30 },
        },
        { headers: { "x-request-id": `request_${calls}` } }
      )
    }
    if (String(input) === "https://api.openai.com/v1/chat/completions") {
      calls++
      return Response.json({
        id: `library_${calls}`,
        choices: [
          {
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "choice",
                  type: "function",
                  function: {
                    name: "select_choice",
                    arguments: JSON.stringify({
                      choice: "A",
                      reasons: "Matches evidence",
                    }),
                  },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      })
    }
    // Catalog failures must leave the independently configured Datool model available.
    throw new Error("External requests are disabled in this fixture")
  }) as typeof fetch
  const service = new TracerService(
    createTracerDatabase(undefined, { projectId })
  )
  await assert.rejects(
    resolveJudgeOptions({ ...defaultScorer, provider: undefined }, projectId),
    /Select Datool Scorer Model/
  )
  const scorer = await run(
    service.scorers.save({
      ...defaultScorer,
      name: "Managed scorer",
      slug: "managed-scorer",
      provider: "datool",
      model: "gpt-6-luna",
      modelType: "language",
    })
  )
  const trace = await run(
    service.createTrace({
      name: "Funded evaluation",
      input: "hello",
      output: "hello",
      status: "completed",
    })
  )
  const preview = await run(
    service.agent.testScorer({ traceId: trace.id, scorerId: scorer.id })
  )
  assert.equal(preview.result.error, undefined)
  assert.equal(preview.result.score, 1)
  assert.equal(preview.result.metadata?.fundingSource, "datool")
  const evaluation = await run(
    service.createEvalRun({ evaluatorIds: [scorer.id], traceIds: [trace.id] })
  )
  assert.equal(evaluation.results[0].score, 1)
  assert.equal(calls, 2)
  assert.equal((await executionCredits.usage(organizationId)).used, 0.00005)
  const artifact = await run(service.getTraceArtifact(trace.id))
  assert(
    artifact.spans.some((span) =>
      Array.isArray(span.attributes.creditOperations)
    ),
    "Persisted execution evidence contains the ledger operation IDs"
  )
  const libraryConfig = defaultLibraryScorer("Factuality")
  const config = {
    ...defaultScorer,
    name: "Library",
    slug: "library",
    type: "library" as const,
    provider: "datool" as const,
    model: "gpt-6-luna",
    modelType: "language" as const,
    library: {
      ...libraryConfig,
      mappings: { ...libraryConfig.mappings, expected: "trace.output" },
    },
  }
  const library = await run(service.scorers.save(config))
  const libraryPreview = await run(
    service.agent.testScorer({ traceId: trace.id, scorerId: library.id })
  )
  assert.equal(
    libraryPreview.result.error,
    undefined,
    JSON.stringify(libraryPreview.result)
  )
  assert.equal(calls, 3)

  const context = await getAuth().$context
  const session = await context.internalAdapter.createSession(ownerId)
  assert(session)
  const signature = await makeSignature(session.token, context.secret)
  const cookie = `${context.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  const request = new Request("http://localhost:3000/api/organizations/usage", {
    headers: { cookie },
  })
  const usage = await getUsage(request, {
    params: Promise.resolve({ organizationId }),
  })
  assert.equal(usage.status, 200)
  assert.equal((await usage.json()).credits.projects[0].id, projectId)
  assert.equal(
    (
      await getUsage(request, {
        params: Promise.resolve({ organizationId: "unrelated" }),
      })
    ).status,
    403
  )
  assert.equal(
    (
      await getUsage(new Request(request.url), {
        params: Promise.resolve({ organizationId }),
      })
    ).status,
    401
  )
  const catalog = await modelCatalog(request, {
    params: Promise.resolve({ projectId }),
  })
  assert.equal((await catalog.json()).datoolModel, true)
  console.log(
    "PASS paid grant, no-key model preview, saved eval, library scorer, usage authorization, and independent model selection"
  )
} finally {
  globalThis.fetch = originalFetch
  await db.end()
  await analyticsDb.end()
}
