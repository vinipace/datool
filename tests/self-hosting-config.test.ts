import { expect, test } from "bun:test"
import { spawnSync } from "node:child_process"

const valid = {
  BETTER_AUTH_URL: "https://datool.example.test",
  BETTER_AUTH_SECRET: "test-only-secret-that-is-at-least-32-characters",
  AUTH_ALLOWED_DOMAINS: "example.test",
  RESEND_API_KEY: "test-only-provider-key",
  RESEND_FROM_EMAIL: "signin@example.test",
}
function check(overrides: Record<string, string | undefined> = {}) {
  return spawnSync(
    process.execPath.replace(/bun$/, "node"),
    ["scripts/check-self-hosting.mjs"],
    {
      encoding: "utf8",
      env: { NODE_ENV: "test", PATH: process.env.PATH, ...valid, ...overrides },
    }
  )
}
test("magic-link and Google-only installations need no CMS secret", () => {
  expect(check().status).toBe(0)
  expect(
    check({
      RESEND_API_KEY: "",
      RESEND_FROM_EMAIL: "",
      GOOGLE_CLIENT_ID: "test-client",
      GOOGLE_CLIENT_SECRET: "test-secret",
    }).status
  ).toBe(0)
})
test("incomplete sign-in, unsafe origins, weak secrets, and unconfigured CMS stop startup", () => {
  for (const settings of [
    { RESEND_API_KEY: "", RESEND_FROM_EMAIL: "" },
    { GOOGLE_CLIENT_ID: "partial-client" },
    { RESEND_FROM_EMAIL: "" },
    { AUTH_ALLOWED_DOMAINS: " , " },
    { BETTER_AUTH_URL: "http://example.test" },
    { BETTER_AUTH_URL: "https://example.test/subpath" },
    { BETTER_AUTH_SECRET: "short" },
    { DATOOL_CMS_ENABLED: "true" },
    { DATOOL_CMS_ENABLED: "yes" },
  ]) {
    const result = check(settings)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("configuration is incomplete")
    expect(result.stderr).not.toContain(valid.BETTER_AUTH_SECRET)
    expect(result.stderr).not.toContain(valid.RESEND_API_KEY)
  }
})
test("CMS opt-in requires its own secret; public signup is deliberate", () => {
  expect(
    check({
      DATOOL_CMS_ENABLED: "true",
      PAYLOAD_SECRET: "cms-test-only-secret-at-least-32-characters",
    }).status
  ).toBe(0)
  expect(
    check({ AUTH_ALLOWED_DOMAINS: "", AUTH_ALLOW_PUBLIC_SIGNUP: "true" }).status
  ).toBe(0)
})
