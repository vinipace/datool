import assert from "node:assert/strict"
import { once } from "node:events"
import { makeSignature } from "better-auth/crypto"
import { getAuth } from "../../lib/auth"
import { db } from "../../lib/db"
import { GET as list, POST as create } from "../../app/api/prompts/route"
import {
  GET as get,
  PUT as update,
  DELETE as remove,
} from "../../app/api/prompts/[id]/route"
import { GET as bySlug } from "../../app/api/prompts/by-slug/[slug]/route"
import { POST as publish } from "../../app/api/prompts/[id]/publish/route"
import { POST as preview } from "../../app/api/prompts/test/route"
import { defaultPrompt } from "../../src/lib/tracer/prompts"
import { routeCacheRedis } from "../../src/server/cache/redis"
import {
  createOrganizationKey,
  revokeOrganizationKey,
} from "../../src/server/auth/key-management"

const redis = routeCacheRedis()

try {
  if (redis && redis.status !== "ready") await once(redis, "ready")
  const auth = await getAuth().$context
  async function session(name: string) {
    const user = await auth.internalAdapter.createUser(
      { name, email: `${name}@example.test`, emailVerified: true },
      { method: "oauth" }
    )
    const session = await auth.internalAdapter.createSession(user.id)
    assert(session)
    const signature = await makeSignature(session.token, auth.secret)
    return `${auth.authCookies.sessionToken.name}=${encodeURIComponent(`${session.token}.${signature}`)}`
  }
  const owner = await session("prompt-owner")
  const outsider = await session("prompt-outsider")
  const organization = await getAuth().api.createOrganization({
    headers: new Headers({ cookie: owner }),
    body: { name: "Prompt tests", slug: "prompt-tests" },
  })
  assert(organization)
  await db.query(
    "INSERT INTO project (id, organization_id, name, slug) VALUES ('prompt-a', $1, 'A', 'prompt-a'), ('prompt-b', $1, 'B', 'prompt-b')",
    [organization.id]
  )
  function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = owner,
    project = "prompt-a",
    origin = "http://localhost:3000"
  ) {
    return new Request(`http://localhost:3000/api/prompts${path}`, {
      method,
      headers: {
        cookie,
        origin,
        "x-project-id": project,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  }
  const config = {
    ...defaultPrompt,
    name: "Support",
    slug: "support",
    model: "openai/gpt-4.1-mini",
    messages: [{ role: "system", content: "Help the user." }],
    metadata: { owner: "support" },
    temperature: 0.4,
  }
  assert.equal((await create(request("", "POST", config, ""))).status, 401)
  assert.equal(
    (await create(request("", "POST", config, outsider))).status,
    403
  )
  assert.equal(
    (
      await create(
        request(
          "",
          "POST",
          config,
          owner,
          "prompt-a",
          "https://untrusted.example"
        )
      )
    ).status,
    403
  )
  assert.equal(
    (await create(request("", "POST", { ...config, messages: [] }))).status,
    400
  )
  const created = await create(request("", "POST", config))
  assert.equal(created.status, 200)
  const { data: saved } = await created.json()
  const context = { params: Promise.resolve({ id: saved.id }) }
  assert.equal((await get(request(`/${saved.id}`), context)).status, 200)
  assert.equal(
    (
      await get(
        request(`/${saved.id}`, "GET", undefined, owner, "prompt-b"),
        context
      )
    ).status,
    404
  )
  assert.equal(
    (await get(request(`/${saved.id}`, "GET", undefined, outsider), context))
      .status,
    403
  )
  const slugContext = { params: Promise.resolve({ slug: "support" }) }
  assert.equal(
    (await bySlug(request("/by-slug/support"), slugContext)).status,
    404
  )
  assert.equal(
    (
      await publish(
        request(
          `/${saved.id}/publish`,
          "POST",
          { expectedRevision: 1 },
          outsider
        ),
        context
      )
    ).status,
    403
  )
  assert.equal(
    (
      await publish(
        request(
          `/${saved.id}/publish`,
          "POST",
          { expectedRevision: 1 },
          owner,
          "prompt-b"
        ),
        context
      )
    ).status,
    404
  )
  assert.equal(
    (
      await publish(
        request(
          `/${saved.id}/publish`,
          "POST",
          { expectedRevision: 1 },
          owner,
          "prompt-a",
          "https://untrusted.example"
        ),
        context
      )
    ).status,
    403
  )
  assert.equal(
    (await publish(request(`/${saved.id}/publish`, "POST", {}, owner), context))
      .status,
    400
  )
  const published = await publish(
    request(`/${saved.id}/publish`, "POST", { expectedRevision: 1 }),
    context
  )
  assert.equal(published.status, 200)
  assert.equal((await published.json()).data.publishedVersion, 1)
  assert.equal(
    (
      await update(
        request(`/${saved.id}`, "PUT", {
          ...config,
          name: "Updated",
          expectedRevision: 2,
        }),
        context
      )
    ).status,
    200
  )
  assert.equal(
    (
      await update(
        request(`/${saved.id}`, "PUT", { ...config, expectedRevision: 2 }),
        context
      )
    ).status,
    409
  )
  assert.equal(
    (
      await publish(
        request(`/${saved.id}/publish`, "POST", { expectedRevision: 2 }),
        context
      )
    ).status,
    409
  )
  const runtimeBeforePublish = await bySlug(
    request("/by-slug/support"),
    slugContext
  )
  assert.equal((await runtimeBeforePublish.json()).data.name, "Support")
  assert.equal(
    (
      await publish(
        request(`/${saved.id}/publish`, "POST", { expectedRevision: 3 }),
        context
      )
    ).status,
    200
  )
  const runtimeAfterPublish = (
    await (await bySlug(request("/by-slug/support"), slugContext)).json()
  ).data
  assert.equal(runtimeAfterPublish.name, "Updated")
  assert.equal(runtimeAfterPublish.version, 2)
  const key = await createOrganizationKey(request(""), organization.id, {
    name: "Prompt reader",
    scopes: ["prompts:read"],
  })
  const keyRequest = (token: string, project = "prompt-a") =>
    new Request("http://localhost:3000/api/prompts/by-slug/support", {
      headers: { authorization: `Bearer ${token}`, "x-project-id": project },
    })
  let promptQueries = 0
  const originalQuery = db.query
  db.query = ((...args: unknown[]) => {
    const statement = args[0]
    const text =
      typeof statement === "string"
        ? statement
        : statement && typeof statement === "object" && "text" in statement
          ? String(statement.text)
          : ""
    if (/managed_prompt(?:s|_versions)/.test(text)) promptQueries++
    return Reflect.apply(originalQuery, db, args)
  }) as typeof db.query
  try {
    for (let i = 0; i < 5; i++) {
      const response = await bySlug(keyRequest(key.key), slugContext)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get("cache-control"), "no-store")
      const data = (await response.json()).data
      assert.equal(data.model, config.model)
      assert.deepEqual(data.metadata, config.metadata)
      assert.equal(data.temperature, config.temperature)
    }
  } finally {
    db.query = originalQuery
  }
  if (redis)
    assert.equal(
      promptQueries,
      0,
      "Warm authorized reads must skip prompt SQL queries"
    )
  // A warm server cache must never skip fresh project/permission checks.
  assert.equal(
    (await bySlug(keyRequest(key.key, "prompt-b"), slugContext)).status,
    404
  )
  assert.equal(
    (
      await bySlug(
        request("/by-slug/support", "GET", undefined, outsider),
        slugContext
      )
    ).status,
    403
  )
  assert.equal(
    (
      await bySlug(
        request("/by-slug/support", "GET", undefined, ""),
        slugContext
      )
    ).status,
    401
  )
  const wrongScope = await createOrganizationKey(request(""), organization.id, {
    name: "Trace reader",
    scopes: ["traces:read"],
  })
  assert.equal(
    (await bySlug(keyRequest(wrongScope.key), slugContext)).status,
    403
  )
  await revokeOrganizationKey(request(""), organization.id, key.id)
  assert.equal((await bySlug(keyRequest(key.key), slugContext)).status, 401)
  const historical = await get(request(`/${saved.id}?version=1`), context)
  assert.equal((await historical.json()).data.name, "Support")
  assert.equal(
    (await get(request(`/${saved.id}?version=invalid`), context)).status,
    400
  )
  const missingProvider = await preview(
    request("/test", "POST", {
      config,
      messages: [{ role: "user", content: "Hi" }],
    })
  )
  assert.equal(missingProvider.status, 400)
  assert.match((await missingProvider.json()).error.message, /Configure Vercel/)
  assert.equal(
    (
      await remove(
        request(`/${saved.id}`, "DELETE", { expectedRevision: 1 }),
        context
      )
    ).status,
    409
  )
  assert.equal(
    (
      await remove(
        request(`/${saved.id}`, "DELETE", { expectedRevision: 4 }),
        context
      )
    ).status,
    200
  )
  assert.deepEqual((await (await list(request(""))).json()).data, [])
  assert.equal(
    (await bySlug(request("/by-slug/support"), slugContext)).status,
    404
  )
  assert.equal(
    (await get(request(`/${saved.id}?version=1`), context)).status,
    404
  )
  console.log(
    "PASS prompt REST permissions, warm-cache key revocation, full configuration, draft saves, publishing, historical reads and deletion"
  )
} finally {
  redis?.disconnect()
  await db.end()
}
