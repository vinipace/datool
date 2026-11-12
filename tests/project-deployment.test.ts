import { test, expect } from "bun:test"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "./helpers/postgres"

// Primary owner of deployment publication, real CLI/MCP transport, sandbox capability
// execution and tenant persistence. Real Postgres and Docker; no tool/runtime mocks.
test("CLI deployment publishes atomic project MCP revisions with isolated durable resources", async () => {
  const target = await createIsolatedPostgres()
  const directory = await mkdtemp(join(tmpdir(), "datool-deploy-test-"))
  try {
    await migrateIsolatedPostgres(target)
    await seedTestWorkspace(target)
    const result = await promisify(execFile)(
      process.execPath,
      ["--no-env-file", "tests/helpers/project-deployment.ts"],
      {
        env: {
          ...process.env,
          DATABASE_URL: target.databaseUrl,
          TEST_PROJECT: target.projectId,
          TEST_ORGANIZATION: target.organizationId,
          TEST_OWNER: target.ownerId,
          BETTER_AUTH_URL: "http://127.0.0.1:3000",
          BETTER_AUTH_SECRET: "deployment-test-secret-at-least-32-characters",
          DATOOL_PROVIDER_ENCRYPTION_KEY:
            "deployment-test-key-at-least-32-characters",
          DATOOL_BUILD_ENABLED: "true",
          DATOOL_BILLING_ENABLED: "false",
          DATOOL_DATA_DIR: directory,
          DATOOL_API_KEY: "",
          DATOOL_PROJECT_ID: "",
          DATOOL_HOST_SECRET: "must-not-reach-sandbox",
          NEXT_TELEMETRY_DISABLED: "1",
        },
        timeout: 240_000,
        maxBuffer: 1024 * 1024,
      }
    )
    expect(result.stdout).toContain(
      "PASS deployment publication, CLI, MCP, sandbox and isolation"
    )
  } finally {
    await target.close()
    await rm(directory, { recursive: true, force: true })
  }
}, 300_000)

// The Eve bridge is a distinct execution boundary from the MCP HTTP transport.
test("deployed agent actions execute their pinned code through Eve", async () => {
  const { createEveFixture, invokeTool } = await import("./helpers/eve-fixture")
  const { deployProject } = await import("@/src/server/deploy/service")
  const { runAgentTurn } = await import("@/src/server/build/runtime")
  const { sql } = await import("drizzle-orm")
  const previous = process.env.DATOOL_BUILD_ENABLED
  process.env.DATOOL_BUILD_ENABLED = "true"
  const fixture = await createEveFixture()
  try {
    await deployProject(fixture.context, {
      expectedDeploymentId: null,
      bundle: {
        version: 1,
        config: { sandbox: "local" },
        code: `export const tools={lookup_record:{description:"Lookup a record",inputSchema:{type:"object",properties:{},additionalProperties:false},execute:async(_,ctx)=>{await ctx.db.set("records","one",{message:"Saved by deployed tool"},0);return ctx.db.get("records","one")}}};export const sources={};`,
        tools: ["lookup_record"],
        collectors: [],
        sources: [],
        skills: [],
        agents: [
          {
            slug: "deployed",
            instructions: "Use lookup_record.",
            configuration: {
              provider: "openai",
              model: "gpt-4.1-mini",
              guardrails: { jevCheckEnabled: false },
            },
          },
        ],
      },
    })
    const agents = await fixture.context.database.execute<{ agent_id: string }>(
      sql`SELECT agent_id FROM project_deployed_agents WHERE project_id=${fixture.context.projectId}`
    )
    fixture.provider((body) => invokeTool(body, {}, "Saved.", "Lookup"))
    const run = await runAgentTurn(fixture.context, {
      agentId: agents.rows[0].agent_id,
      channel: "api",
      requestKey: crypto.randomUUID(),
      message: "Lookup a record",
    })
    expect(
      run.toolCalls.some(
        (call) =>
          call.status === "completed" &&
          JSON.stringify(call.output).includes("Saved by deployed tool")
      )
    ).toBe(true)
    const stored = await fixture.context.database.execute<{ value: unknown }>(
      sql`SELECT value FROM project_documents WHERE project_id=${fixture.context.projectId} AND collection='records' AND key='one'`
    )
    expect(stored.rows[0].value).toEqual({ message: "Saved by deployed tool" })
  } finally {
    if (previous === undefined) delete process.env.DATOOL_BUILD_ENABLED
    else process.env.DATOOL_BUILD_ENABLED = previous
    await fixture.close()
  }
}, 90_000)
