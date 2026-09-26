import { test, expect } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
} from "./helpers/postgres"

test("organization invitations enforce permissions, verified acceptance, expiration, and recoverable email delivery", async () => {
  const target = await createIsolatedPostgres()
  try {
    await migrateIsolatedPostgres(target)
    const { stdout } = await promisify(execFile)(
      "bun",
      ["--no-env-file", "tests/helpers/invitations-integration.ts"],
      {
        env: {
          ...process.env,
          NODE_ENV: "development",
          DATABASE_URL: target.databaseUrl,
          BETTER_AUTH_URL: "http://localhost:3000",
          BETTER_AUTH_SECRET:
            "invitation-test-secret-with-at-least-thirty-two-characters",
          DATOOL_BILLING_ENABLED: "false",
          RESEND_API_KEY: "re_fixture",
          RESEND_FROM_EMAIL: "Datool <invites@example.test>",
          GOOGLE_CLIENT_ID: "invite-fixture",
          GOOGLE_CLIENT_SECRET: "invite-fixture",
          AUTH_ALLOWED_DOMAINS: "example.test",
          AUTH_ALLOW_PUBLIC_SIGNUP: "false",
        },
      }
    )
    expect(stdout).toContain("PASS invitations")
  } finally {
    await target.close()
  }
}, 60_000)
