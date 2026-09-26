import { rejects } from "node:assert/strict"
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { eq } from "drizzle-orm"
import {
  defaultPrompt,
  promptInputSchema,
  promptDraftSchema,
  renderPrompt,
  promptVariables,
} from "../src/lib/tracer/prompts"
import { createPromptService } from "../src/server/tracer/prompts"
import { previewPrompt } from "../src/server/tracer/prompt-preview"
import { managedPromptVersions } from "../src/server/tracer/schema"
import {
  registerTracerProjectId,
  getTracerProjectId,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import { routeScopes } from "../src/server/auth/request"
import { OPENAI_PROVIDER } from "../src/lib/model-providers"

const config = {
  ...defaultPrompt,
  name: "Support",
  slug: "support",
  model: "openai/gpt-4.1-mini",
  messages: [
    {
      role: "system" as const,
      content: "Help {{customer}} with {{topic}}. {{customer}}",
    },
  ],
}

test("prompt templates require own named values, substitute literally and support plain text", () => {
  expect(promptVariables(config)).toEqual(["customer", "topic"])
  expect(() => renderPrompt(config, { customer: "A" })).toThrow("topic")
  expect(
    renderPrompt(config, { customer: "$& <A>", topic: "{{nested}}" })[0].content
  ).toBe("Help $& <A> with {{nested}}. $& <A>")
  expect(renderPrompt({ ...config, template: "none" }, {})).toEqual(
    config.messages
  )
  expect(() =>
    renderPrompt(
      { ...config, messages: [{ role: "user", content: "{{constructor}}" }] },
      {}
    )
  ).toThrow("constructor")
  expect(
    promptDraftSchema.safeParse({
      ...defaultPrompt,
      name: "Draft",
      slug: "draft",
    }).success
  ).toBe(true)
  for (const patch of [
    { slug: "Bad Slug" },
    { model: "" },
    { messages: [] },
    { temperature: 3 },
    { maxTokens: 0 },
    { metadata: [] },
  ])
    expect(promptInputSchema.safeParse({ ...config, ...patch }).success).toBe(
      false
    )
})

test("preview sends rendered prompt plus chat history with configured parameters", async () => {
  let body: Record<string, unknown> = {}
  const transport = (async (url: string, init: RequestInit) => {
    expect(url).toBe("https://ai-gateway.vercel.sh/v1/chat/completions")
    body = JSON.parse(init.body as string)
    return Response.json({ choices: [{ message: { content: "Hello!" } }] })
  }) as typeof fetch
  const result = await previewPrompt(
    {
      config: { ...config, output: "json", temperature: 0.2, maxTokens: 300 },
      variables: { customer: "Sam", topic: "billing" },
      messages: [{ role: "user", content: "Hi" }],
    },
    "project-a",
    { apiKey: "test-key", fetch: transport }
  )
  expect(result).toEqual({ role: "assistant", content: "Hello!" })
  expect(body.messages).toEqual([
    { role: "system", content: "Help Sam with billing. Sam" },
    { role: "user", content: "Hi" },
  ])
  expect(body.temperature).toBe(0.2)
  expect(body.max_tokens).toBe(300)
  expect(body.response_format).toEqual({ type: "json_object" })
  await rejects(
    previewPrompt(
      { config, variables: {}, messages: [{ role: "user", content: "Hi" }] },
      "a",
      { apiKey: "test", fetch: transport }
    ),
    (error: Error) => error.message.includes("Enter values")
  )
  await rejects(
    previewPrompt(
      {
        config,
        variables: { customer: "Sam", topic: "billing" },
        messages: [{ role: "user", content: "Hi" }],
      },
      "a",
      {
        apiKey: "test",
        fetch: (async () =>
          new Response("secret", { status: 401 })) as typeof fetch,
      }
    ),
    (error: Error) => error.message.includes("Model request failed (401)")
  )
})

test("prompt REST operations require dedicated read and write permissions", async () => {
  expect(
    await routeScopes(
      new Request("http://localhost/api/prompts/by-slug/support")
    )
  ).toEqual(["prompts:read"])
  expect(
    await routeScopes(
      new Request("http://localhost/api/prompts/prompt_a/publish", {
        method: "POST",
      })
    )
  ).toEqual(["prompts:write"])
  for (const method of ["POST", "PUT", "DELETE"])
    expect(
      await routeScopes(
        new Request("http://localhost/api/prompts/test", { method })
      )
    ).toEqual(["prompts:write"])
})

test("OpenAI prompt versions preserve direct IDs and provider when drafts switch to Gateway", async () => {
  const db = await createTracerFixture()
  try {
    const service = createPromptService(db)
    const created = await Effect.runPromise(service.save({ ...config, provider: OPENAI_PROVIDER, model: "gpt-4.1-mini" }))
    await Effect.runPromise(service.publish(created.id, { expectedRevision: created.revision }))
    const published = await Effect.runPromise(service.get(created.id))
    await Effect.runPromise(service.save({ ...config, expectedRevision: published.revision }, created.id))
    expect(await Effect.runPromise(service.get(created.id, false, 1))).toMatchObject({ provider: OPENAI_PROVIDER, model: "gpt-4.1-mini" })
    expect(await Effect.runPromise(service.get(created.id))).toMatchObject({ provider: config.provider, model: config.model })
  } finally {
    await closeTracerFixture(db)
  }
})

test("drafts publish immutable versions without changing agent reads until publication", async () => {
  const db = await createTracerFixture()
  const reopened = reopenTracerFixture(db)
  const run = Effect.runPromise
  try {
    const service = createPromptService(db)
    const created = await run(
      service.save({ ...defaultPrompt, name: "Support", slug: "support" })
    )
    expect(created.revision).toBe(1)
    expect(created.publishedVersion).toBeNull()
    expect(created.hasDraft).toBe(true)
    expect(await run(createPromptService(reopened).get(created.id))).toEqual(
      created
    )
    await rejects(run(service.get("support", true)), /not found/)
    await rejects(run(service.get(created.id, false, 1)), /not found/)
    await rejects(
      run(service.publish(created.id, { expectedRevision: 1 })),
      /Select a model/
    )
    const ready = await run(
      service.save({ ...config, expectedRevision: 1 }, created.id)
    )
    expect(ready.revision).toBe(2)
    expect(await db.select().from(managedPromptVersions)).toHaveLength(0)
    const published = await run(
      service.publish(created.id, { expectedRevision: 2 })
    )
    expect(published).toMatchObject({
      revision: 3,
      publishedVersion: 1,
      hasDraft: false,
    })
    expect((await run(service.get("support", true))).version).toBe(1)
    await rejects(
      run(
        service.save(
          { ...config, slug: "renamed", expectedRevision: 3 },
          created.id
        )
      ),
      /slug cannot be changed/
    )
    const updated = await run(
      service.save(
        { ...config, description: "Draft changes", expectedRevision: 3 },
        created.id
      )
    )
    expect(updated).toMatchObject({
      revision: 4,
      publishedVersion: 1,
      hasDraft: true,
    })
    expect((await run(service.get("support", true))).description).toBe("")
    expect((await run(service.get(created.id))).description).toBe(
      "Draft changes"
    )
    expect((await run(service.get(created.id, false, 1))).description).toBe("")
    expect((await run(service.list()))[0].hasDraft).toBe(true)
    await rejects(
      run(service.save({ ...config, expectedRevision: 3 }, created.id)),
      /changed/
    )
    await rejects(
      run(service.publish(created.id, { expectedRevision: 3 })),
      /changed/
    )
    await rejects(run(service.save(config, created.id)))
    await rejects(run(service.save(config)), /slug already exists/)
    expect(
      (await run(service.save({ ...updated, expectedRevision: 4 }, created.id)))
        .revision
    ).toBe(4)
    const second = await run(
      service.publish(created.id, { expectedRevision: 4 })
    )
    expect(second).toMatchObject({
      revision: 5,
      publishedVersion: 2,
      hasDraft: false,
    })
    expect((await run(service.get("support", true))).description).toBe(
      "Draft changes"
    )
    expect((await run(service.get("support", true, 1))).description).toBe("")
    expect(
      (await run(service.publish(created.id, { expectedRevision: 5 }))).revision
    ).toBe(5)
    const originalProject = getTracerProjectId(reopened)
    registerTracerProjectId(reopened, "other-project")
    const other = createPromptService(reopened)
    expect(await run(other.list())).toEqual([])
    await rejects(run(other.get(created.id)), /not found/)
    await rejects(run(other.get("support", true)), /not found/)
    await rejects(
      run(other.publish(created.id, { expectedRevision: 5 })),
      /not found/
    )
    await rejects(run(other.remove(created.id, 5)), /not found/)
    registerTracerProjectId(reopened, originalProject)
    const concurrentSaves = await Promise.allSettled([
      run(
        service.save({ ...updated, name: "A", expectedRevision: 5 }, created.id)
      ),
      run(
        service.save({ ...updated, name: "B", expectedRevision: 5 }, created.id)
      ),
    ])
    expect(
      concurrentSaves.filter((r) => r.status === "fulfilled")
    ).toHaveLength(1)
    expect(concurrentSaves.filter((r) => r.status === "rejected")).toHaveLength(
      1
    )
    const concurrentPublishes = await Promise.allSettled([
      run(service.publish(created.id, { expectedRevision: 6 })),
      run(service.publish(created.id, { expectedRevision: 6 })),
    ])
    expect(
      concurrentPublishes.filter((r) => r.status === "fulfilled")
    ).toHaveLength(1)
    expect(
      concurrentPublishes.filter((r) => r.status === "rejected")
    ).toHaveLength(1)
    const first = await run(service.get(created.id, false, 1))
    await run(service.save({ ...first, expectedRevision: 7 }, created.id))
    const restored = await run(
      service.publish(created.id, { expectedRevision: 8 })
    )
    expect(restored).toMatchObject({
      revision: 9,
      publishedVersion: 4,
      hasDraft: false,
      description: "",
    })
    expect((await run(service.get(created.id, false, 2))).description).toBe(
      "Draft changes"
    )
    await rejects(run(service.remove(created.id, 8)), /changed/)
    await run(service.remove(created.id, 9))
    expect(
      await db
        .select()
        .from(managedPromptVersions)
        .where(eq(managedPromptVersions.promptId, created.id))
    ).toHaveLength(0)
    await rejects(run(service.get(created.id)), /not found/)
  } finally {
    await closeTracerDatabase(reopened)
    await closeTracerFixture(db)
  }
}, 30000)
