import { describe, expect, test } from "bun:test"
import { google } from "better-auth/social-providers"
import { memoryAdapter } from "better-auth/adapters/memory"
import { betterAuth } from "better-auth"
import { Pool } from "pg"
import { organizationAuthOptions } from "../src/server/auth/config"
import { isAllowedGoogleUser } from "../src/server/auth/launch-access"

const user = { email: "alice@example.com", emailVerified: true }
describe("launch access", () => {
  test("requires verified email and exact configured domains", () => {
    expect(isAllowedGoogleUser(user, " Example.COM, partner.com ")).toBe(true)
    for (const email of [
      "a@sub.example.com",
      "a@evil-example.com",
      "a@example.com.evil",
      "a@@example.com",
      "@example.com",
      "a@other.com",
    ]) {
      expect(isAllowedGoogleUser({ ...user, email }, "example.com")).toBe(false)
    }
    expect(isAllowedGoogleUser(user, "")).toBe(false)
    expect(isAllowedGoogleUser(user, " , ")).toBe(false)
    expect(
      isAllowedGoogleUser({ ...user, emailVerified: false }, "example.com")
    ).toBe(false)
    expect(isAllowedGoogleUser({ email: user.email }, "example.com")).toBe(
      false
    )
  })

  test("Google sign-in gates profiles and refreshes returning users' names and photos", async () => {
    const previous = {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET,
      domains: process.env.AUTH_ALLOWED_DOMAINS,
    }
    try {
      process.env.GOOGLE_CLIENT_ID = "test-client"
      process.env.GOOGLE_CLIENT_SECRET = "test-secret"
      process.env.AUTH_ALLOWED_DOMAINS = "example.com"
      const options = organizationAuthOptions({ query: async () => ({ rowCount: 0, rows: [] }) } as unknown as Pool, {
        baseURL: "http://localhost:3000",
        secret: "test-secret-at-least-thirty-two-characters",
      })
      const provider = google(options.socialProviders.google!)
      for (const [email, verified, allowed] of [
        ["a@example.com", true, true],
        ["a@other.com", true, false],
        ["a@example.com", false, false],
      ] as const) {
        // This exercises profile gating, not Google's signature verification.
        const idToken = `e30.${Buffer.from(JSON.stringify({ sub: "user", email, email_verified: verified })).toString("base64url")}.signature`
        expect(Boolean(await provider.getUserInfo({ idToken }))).toBe(allowed)
      }

      // Returning Google users must receive fresh profile data too.
      const now = new Date()
      const records = {
        user: [{ id: "existing-user", email: "a@example.com", emailVerified: true, name: "Old name", image: null, createdAt: now, updatedAt: now }],
        account: [{ id: "google-account", userId: "existing-user", accountId: "user", providerId: "google", createdAt: now, updatedAt: now }],
        session: [],
        verification: [],
      }
      const auth = betterAuth({
        ...options,
        database: memoryAdapter(records),
        plugins: [],
        rateLimit: { enabled: false },
      })
      const picture = "https://example.com/avatar.png"
      const token = `e30.${Buffer.from(JSON.stringify({ sub: "user", email: "a@example.com", email_verified: true, name: "Alice", picture })).toString("base64url")}.signature`
      const context = await auth.$context
      const testProvider = context.socialProviders.find((item) => item.id === "google")!
      // Stub only Google's token exchange; run the real redirect callback and profile mapping.
      testProvider.validateAuthorizationCode = async () => ({ idToken: token })
      const signIn = await auth.handler(new Request("http://localhost:3000/api/auth/sign-in/social", {
        method: "POST",
        headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ provider: "google", callbackURL: "/", disableRedirect: true }),
      }))
      const authorizationUrl = new URL((await signIn.json()).url)
      const state = authorizationUrl.searchParams.get("state")!
      const response = await auth.handler(new Request(`http://localhost:3000/api/auth/callback/google?code=test-code&state=${encodeURIComponent(state)}`, {
        headers: { cookie: signIn.headers.getSetCookie().map((cookie) => cookie.split(";")[0]).join("; ") },
      }))
      expect(response.status).toBe(302)
      expect(response.headers.get("location")).toBe("/")
      expect(records.user[0]).toMatchObject({ name: "Alice", image: picture })
    } finally {
      for (const [key, value] of Object.entries({
        GOOGLE_CLIENT_ID: previous.id,
        GOOGLE_CLIENT_SECRET: previous.secret,
        AUTH_ALLOWED_DOMAINS: previous.domains,
      })) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  })

  test("direct email sign-in and signup requests are disabled", async () => {
    const auth = betterAuth({
      ...organizationAuthOptions(new Pool(), {
        baseURL: "http://localhost:3000",
        secret: "test-secret-at-least-thirty-two-characters",
      }),
      database: memoryAdapter({
        user: [],
        session: [],
        account: [],
        verification: [],
        oauthResource: [],
      }),
      rateLimit: { enabled: false },
    })
    for (const path of ["sign-in/email", "sign-up/email"]) {
      const response = await auth.handler(
        new Request(`http://localhost:3000/api/auth/${path}`, {
          method: "POST",
          headers: {
            origin: "http://localhost:3000",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: "a@example.com",
            name: "Test",
            password: "password-long-enough",
          }),
        })
      )
      expect(response.ok).toBe(false)
      expect(response.status).toBe(400)
    }
  })

  test("optional password sign-in requires an existing verified account and current email policy", async () => {
    const keys = ["AUTH_PASSWORD_SIGN_IN_ENABLED", "AUTH_ALLOWED_DOMAINS", "AUTH_ALLOW_PUBLIC_SIGNUP"] as const
    const previous = keys.map(key => process.env[key])
    try {
      process.env.AUTH_PASSWORD_SIGN_IN_ENABLED = "true"
      process.env.AUTH_ALLOWED_DOMAINS = "example.com"
      process.env.AUTH_ALLOW_PUBLIC_SIGNUP = "false"
      const now = new Date()
      const records = {
        user: [{ id: "reviewer", name: "Review account", email: "reviewer@example.com", emailVerified: true, createdAt: now, updatedAt: now }],
        account: [] as Record<string, unknown>[], session: [], verification: [],
      }
      const auth = betterAuth({
        ...organizationAuthOptions(new Pool(), {
          baseURL: "http://localhost:3000", secret: "test-secret-at-least-thirty-two-characters",
        }),
        database: memoryAdapter(records), plugins: [], rateLimit: { enabled: false },
      })
      const password = "fixture-password-at-least-sixteen-characters"
      records.account.push({ id: "password-account", providerId: "credential", accountId: "reviewer", userId: "reviewer", password: await (await auth.$context).password.hash(password), createdAt: now, updatedAt: now })
      const request = (path: string, secret = password) => auth.handler(new Request(`http://localhost:3000/api/auth/${path}`, {
        method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
        body: JSON.stringify({ email: "reviewer@example.com", name: "Review account", password: secret }),
      }))
      const signedIn = await request("sign-in/email")
      expect(signedIn.status).toBe(200)
      expect(signedIn.headers.getSetCookie().length).toBeGreaterThan(0)
      expect((await request("sign-in/email", "incorrect-password")).status).toBe(401)
      records.user[0].emailVerified = false
      expect((await request("sign-in/email")).status).toBe(403)
      records.user[0].emailVerified = true
      process.env.AUTH_ALLOWED_DOMAINS = "other.example"
      expect((await request("sign-in/email")).status).toBe(401)
      expect((await request("sign-up/email")).ok).toBe(false)
      expect(records.user).toHaveLength(1)
      expect(records.session).toHaveLength(1)
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key]
        else process.env[key] = previous[index]
      })
    }
  })
})
