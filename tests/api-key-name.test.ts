import { expect, test } from "bun:test"
import { betterAuth } from "better-auth"
import { memoryAdapter } from "better-auth/adapters/memory"
import { Pool } from "pg"
import { organizationAuthOptions } from "../src/server/auth/config"

// Exercise the real auth plugin against test-only memory storage. No live keys.
test("organization keys accept onboarding names and the 100-character boundary", async () => {
  const database = new Pool({ connectionString: "postgresql://test:test@127.0.0.1:1/test" })
  Object.defineProperty(database, "query", { value: async () => ({ rows: [{ creation_disabled: false }] }) })
  const storage = {
    user: [{ id: "test-user", name: "Test", email: "test@example.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() }],
    organization: [{ id: "test-org", name: "Test", slug: "test", createdAt: new Date() }],
    member: [{ id: "test-member", organizationId: "test-org", userId: "test-user", role: "owner", createdAt: new Date() }],
    apikey: [],
    oauthResource: [],
  }
  const auth = betterAuth({
    ...organizationAuthOptions(database, { baseURL: "http://localhost:3000", secret: "test-only-secret-with-at-least-32-characters" }),
    database: memoryAdapter(storage),
  })
  try {
    for (const name of [`Trace ingestion ${"a".repeat(36)}`, "n".repeat(100)]) {
      const result = await auth.api.createApiKey({ body: { name, userId: "test-user", organizationId: "test-org", expiresIn: null, permissions: { traces: ["write"] } } })
      expect(result.name).toBe(name)
      expect(result.expiresAt).toBeNull()
    }
    let error: unknown
    try {
      await auth.api.createApiKey({ body: { name: "n".repeat(101), userId: "test-user", organizationId: "test-org" } })
    } catch (cause) {
      error = cause
    }
    expect(error instanceof Error && error.message.includes("name length")).toBe(true)
  } finally {
    await database.end()
  }
})
