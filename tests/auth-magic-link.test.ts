import { afterEach, beforeEach, expect, test } from "bun:test"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import type { Pool } from "pg"
import { organizationAuthOptions } from "../src/server/auth/config"
import { GET as authConfiguration } from "../app/api/auth/config/route"

const origin = "http://localhost:3000"
const originalFetch = globalThis.fetch
const previousEnvironment = {
  RESEND_API_KEY: process.env.RESEND_API_KEY,
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL,
  AUTH_ALLOWED_DOMAINS: process.env.AUTH_ALLOWED_DOMAINS,
  DATOOL_CMS_ENABLED: process.env.DATOOL_CMS_ENABLED,
  DATOOL_GA_MEASUREMENT_ID: process.env.DATOOL_GA_MEASUREMENT_ID,
}
let messages: { to: string[]; text: string; subject: string }[]
let deliveryFails = false

beforeEach(() => {
  process.env.RESEND_API_KEY = "resend-test-key"
  process.env.RESEND_FROM_EMAIL = "Datool <signin@example.com>"
  process.env.AUTH_ALLOWED_DOMAINS = "example.com"
  process.env.DATOOL_CMS_ENABLED = "true"
  process.env.DATOOL_GA_MEASUREMENT_ID = "G-TEST"
  messages = []
  deliveryFails = false
  globalThis.fetch = (async (input, init) => {
    if (String(input) !== "https://api.resend.com/emails")
      throw new Error("Unexpected external request")
    messages.push(JSON.parse(String(init?.body)))
    return Response.json(
      deliveryFails
        ? { message: "Private provider diagnostic" }
        : { id: "test-message" },
      { status: deliveryFails ? 503 : 200 }
    )
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setup(rateLimit = false) {
  const records: Record<string, Record<string, unknown>[]> = {
    user: [],
    session: [],
    account: [],
    verification: [],
    oauthResource: [],
    jwks: [],
  }
  const options = organizationAuthOptions({} as Pool, {
    baseURL: origin,
    secret: "test-secret-at-least-thirty-two-characters",
  })
  const auth = betterAuth({
    ...options,
    database: memoryAdapter(records),
    advanced: { disableOriginCheck: false, disableCSRFCheck: false },
    rateLimit: { enabled: rateLimit, storage: "memory" },
  })
  const requestLink = (
    email = "alice@example.com",
    callbackURL = "/p/support/traces"
  ) =>
    auth.handler(
      new Request(`${origin}/api/auth/sign-in/magic-link`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          email,
          callbackURL,
          errorCallbackURL: "/sign-in?method=email",
        }),
      })
    )
  const link = () => messages.at(-1)!.text.match(/http:\/\/\S+/)![0]
  return { auth, records, requestLink, link }
}

test("delivers a hashed, one-use link that creates a verified session and preserves the destination", async () => {
  const { auth, records, requestLink, link } = setup()
  const requested = await requestLink(" Alice@Example.com ")
  expect(requested.status).toBe(200)
  expect(
    requested.headers
      .getSetCookie()
      .some((value) => value.startsWith("datool_signup="))
  ).toBe(false)
  expect(messages[0].to).toEqual(["alice@example.com"])
  expect(messages[0].subject).toBe("Sign in to Datool")
  const token = new URL(link()).searchParams.get("token")!
  expect(JSON.stringify(records.verification)).not.toContain(token)
  expect(records.user).toHaveLength(0)
  const response = await auth.handler(
    new Request(link(), { headers: { cookie: "datool_analytics=granted" } })
  )
  expect(response.status).toBe(302)
  expect(
    response.headers
      .getSetCookie()
      .some((value) => value.startsWith("datool_signup=email;"))
  ).toBe(true)
  expect(response.headers.get("location")).toBe(`${origin}/p/support/traces`)
  expect(records.user[0].emailVerified).toBe(true)
  const cookie = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ")
  const session = await auth.handler(
    new Request(`${origin}/api/auth/get-session`, { headers: { cookie } })
  )
  expect((await session.json()).user.email).toBe("alice@example.com")
  const reused = await auth.handler(new Request(link()))
  expect(reused.headers.get("location")).toContain("error=INVALID_TOKEN")
  expect(records.session).toHaveLength(1)
  await requestLink()
  const returning = await auth.handler(new Request(link()))
  expect(
    returning.headers
      .getSetCookie()
      .some((value) => value.startsWith("datool_signup="))
  ).toBe(false)
})

test("expired links cannot create a session", async () => {
  const { auth, records, requestLink, link } = setup()
  await requestLink()
  records.verification[0].expiresAt = new Date(Date.now() - 1000)
  const response = await auth.handler(new Request(link()))
  expect(response.headers.get("location")).toContain("error=INVALID_TOKEN")
  expect(records.session).toHaveLength(0)
  expect(records.user).toHaveLength(0)
})

test("denies disallowed domains before sending mail or issuing a token", async () => {
  const { records, requestLink } = setup()
  for (const email of [
    "alice@other.com",
    "alice@sub.example.com",
    "alice@example.com.evil",
  ]) {
    expect((await requestLink(email)).status).toBe(403)
  }
  expect(messages).toHaveLength(0)
  expect(records.verification).toHaveLength(0)
})

test("rechecks the allowlist when new and existing users redeem links", async () => {
  for (const existing of [false, true]) {
    const { auth, records, requestLink, link } = setup()
    if (existing)
      records.user.push({
        id: "existing",
        email: "alice@example.com",
        name: "Alice",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
    process.env.AUTH_ALLOWED_DOMAINS = "example.com"
    await requestLink()
    process.env.AUTH_ALLOWED_DOMAINS = "other.com"
    const response = await auth.handler(new Request(link()))
    expect(response.status).not.toBe(200)
    expect(response.headers.get("set-cookie")).toBeNull()
    expect(records.session).toHaveLength(0)
    expect(records.user).toHaveLength(existing ? 1 : 0)
  }
})

test("returns a retryable failure without exposing Resend details", async () => {
  const { records, requestLink } = setup()
  deliveryFails = true
  const response = await requestLink()
  expect(response.status).toBe(503)
  const body = await response.text()
  expect(body).toContain("EMAIL_DELIVERY_FAILED")
  expect(body).not.toContain("Private provider diagnostic")
  expect(body).not.toContain("resend-test-key")
  expect(records.session).toHaveLength(0)
  deliveryFails = false
  expect((await requestLink()).status).toBe(200)
})

test("missing sender configuration disables email sign-in in the UI and API", async () => {
  delete process.env.RESEND_FROM_EMAIL
  expect((await authConfiguration().json()).emailLink).toBe(false)
  const { records, requestLink } = setup()
  expect((await requestLink()).status).toBe(503)
  expect(messages).toHaveLength(0)
  expect(records.verification).toHaveLength(0)
})

test("limits repeated requests and rejects external redirect destinations", async () => {
  const limited = setup(true)
  for (let i = 0; i < 5; i++)
    expect((await limited.requestLink()).status).toBe(200)
  expect((await limited.requestLink()).status).toBe(429)
  const { records, requestLink } = setup()
  const sent = messages.length
  expect(
    (await requestLink("alice@example.com", "https://untrusted.example/"))
      .status
  ).toBe(403)
  expect(messages).toHaveLength(sent)
  expect(records.session).toHaveLength(0)
})

test("mobile sign-in returns a session cookie through the trusted native callback", async () => {
  const { auth, requestLink, link } = setup()
  expect(
    (
      await requestLink(
        "alice@example.com",
        "datool-inbox://auth-callback?state=fixture"
      )
    ).status
  ).toBe(200)
  const response = await auth.handler(new Request(link()))
  expect(response.status).toBe(302)
  const callback = new URL(response.headers.get("location")!)
  expect(callback.protocol).toBe("datool-inbox:")
  expect(callback.host).toBe("auth-callback")
  expect(callback.searchParams.get("state")).toBe("fixture")
  const cookie = callback.searchParams.get("cookie")!
  expect(cookie).toContain("better-auth.session_token=")
  const session = await auth.handler(
    new Request(`${origin}/api/auth/get-session`, { headers: { cookie } })
  )
  expect((await session.json()).user.email).toBe("alice@example.com")
})
