import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import {
  createEveFixture,
  eveResponse,
  invokeTool,
} from "./helpers/eve-fixture"
import { agentSandboxSchema } from "@/src/lib/build/sandbox"
import { createAgent, getAgent, updateAgent } from "@/src/server/build/agents"
import { createDrive, listDrives } from "@/src/server/build/drives"
import { runAgentSandboxCommand } from "@/src/server/build/sandbox-runtime"
import { runAgentTurn } from "@/src/server/build/runtime"
import {
  closeTracerDatabase,
  getTracerProjectId,
  registerTracerProjectId,
} from "@/src/server/tracer/db"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"

test("sandbox configuration enforces the mount boundary and four-drive limit", () => {
  const drive = (mountPath: string) => ({ driveId: randomUUID(), mountPath })
  for (const drives of [
    Array.from({ length: 5 }, (_, i) => drive(`/workspace/${i}`)),
    [drive("/workspace/a"), drive("/workspace/a/nested")],
    [drive("/workspace/a"), drive("/workspace/a")],
    [drive("/etc")],
    [drive("/workspace/../etc")],
    [drive("/workspace/a/../../etc")],
  ])
    expect(agentSandboxSchema.safeParse({ drives }).success).toBe(false)
  const duplicate = drive("/workspace/a")
  expect(
    agentSandboxSchema.safeParse({
      drives: [duplicate, { ...duplicate, mountPath: "/workspace/b" }],
    }).success
  ).toBe(false)
  expect(
    agentSandboxSchema.parse({
      drives: Array.from({ length: 4 }, (_, i) => drive(`/workspace/${i}`)),
    }).drives
  ).toHaveLength(4)
})

test("drive ownership is checked when saving drafts and applied agent revisions", async () => {
  const database = await createTracerFixture()
  const projectId = getTracerProjectId(database)
  const context = { database, projectId }
  const foreignProject = randomUUID()
  const foreignDb = registerTracerProjectId(
    reopenTracerFixture(database),
    foreignProject
  )
  const foreign = { database: foreignDb, projectId: foreignProject }
  try {
    await database.execute(
      sql`INSERT INTO project (id, organization_id, name, slug) SELECT ${foreignProject}, organization_id, 'Other', ${foreignProject} FROM project WHERE id = ${projectId}`
    )
    const a = await createDrive(context, {
      name: "Research",
      provider: "local",
    })
    const b = await createDrive(context, { name: "Finance", provider: "local" })
    const other = await createDrive(foreign, {
      name: "Private",
      provider: "local",
    })
    const first = await listDrives(context, { limit: 1 })
    const second = await listDrives(context, {
      limit: 1,
      after: first.nextCursor!,
    })
    expect(
      new Set([...first.items, ...second.items].map((drive) => drive.id))
    ).toEqual(new Set([a.id, b.id]))
    expect(second.nextCursor).toBeNull()
    expect((await listDrives(foreign)).items.map((drive) => drive.id)).toEqual([
      other.id,
    ])
    // A mounted drive does not imply its compute provider is configured.
    // Reject unavailable execution at publication, while allowing setup drafts.
    await rejects(
      createAgent(context, {
        name: "Unavailable sandbox",
        configuration: { sandbox: { enabled: true, provider: "datool" } },
      }),
      /Datool Sandbox is not configured/
    )
    const setup = await createAgent(context, { name: "Sandbox setup draft" })
    const unready = await updateAgent(context, setup.id, {
      expectedRevision: setup.currentRevision,
      apply: false,
      configuration: {
        ...setup.configuration,
        sandbox: { ...setup.configuration.sandbox, enabled: true },
      },
    })
    await rejects(
      updateAgent(context, setup.id, {
        expectedRevision: unready.currentRevision,
        apply: true,
      }),
      /Datool Sandbox is not configured/
    )
    expect(
      (await getAgent(context, setup.id)).appliedConfiguration?.sandbox.enabled
    ).toBe(false)
    const agent = await createAgent(context, { name: "Research assistant" })
    expect(agent.configuration.sandbox.enabled).toBe(false)
    const configured = (driveId: string, provider = "local") => ({
      ...agent.configuration,
      sandbox: {
        enabled: true,
        provider,
        drives: [{ driveId, mountPath: "/workspace/context" }],
      },
    })
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: 1,
        configuration: configured(other.id),
      }),
      /unavailable in this project/
    )
    await rejects(
      updateAgent(context, agent.id, {
        expectedRevision: 1,
        configuration: configured(a.id, "modal"),
      }),
      /selected sandbox provider/
    )
    const draft = await updateAgent(context, agent.id, {
      expectedRevision: 1,
      configuration: configured(a.id),
      apply: false,
    })
    expect(draft.configuration.sandbox.drives[0].driveId).toBe(a.id)
    expect(draft.appliedConfiguration?.sandbox.enabled).toBe(false)
    const applied = await updateAgent(context, agent.id, {
      expectedRevision: draft.currentRevision,
      apply: true,
    })
    expect(
      (await getAgent(context, applied.id)).appliedConfiguration?.sandbox
        .drives[0].driveId
    ).toBe(a.id)
    const config = agentSandboxSchema.parse(configured(other.id).sandbox)
    await rejects(
      runAgentSandboxCommand(context, config, { command: "echo forbidden" }),
      /unavailable in this project/
    )
  } finally {
    await closeTracerDatabase(foreignDb)
    await closeTracerFixture(database)
  }
})

// Owns actual filesystem persistence through the model tool loop, agent revisions,
// fresh conversations and different environments. No provider/filesystem mocks.
test("human approval and simulation isolation prevent sandbox tools reaching the model", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  try {
    fixture.provider((body) => {
      expect(JSON.stringify(body.tools ?? [])).not.toContain("eve__tool")
      return eveResponse(body, "Ready.")
    })
    for (const [name, enabled, human] of [
      ["Disabled", false, false],
      ["Human approval", true, true],
    ] as const) {
      const agent = await createAgent(context, {
        name,
        configuration: {
          provider: "openai",
          model: "gpt-4.1-mini",
          sandbox: { enabled, provider: "local" },
          guardrails: { jevCheckEnabled: false, requireHumanForActions: human },
        },
      })
      expect(
        (
          await runAgentTurn(context, {
            agentId: agent.id,
            channel: "api",
            requestKey: randomUUID(),
            message: "Hello",
          })
        ).status
      ).toBe("completed")
    }
    const agent = await createAgent(context, {
      name: "Unpersisted simulation",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        sandbox: { enabled: true, provider: "local" },
        guardrails: { jevCheckEnabled: false },
      },
    })
    const count = fixture.requests.length
    await rejects(
      runAgentTurn(
        context,
        {
          agentId: agent.id,
          channel: "api",
          requestKey: randomUUID(),
          message: "Hello",
        },
        { dependencies: { mockExternalActions: true } }
      ),
      (error) =>
        (error as { code?: string }).code === "SIMULATION_CONTEXT_REQUIRED"
    )
    expect(fixture.requests.length).toBe(count)
  } finally {
    await fixture.close()
  }
}, 30_000)

if (process.env.DATOOL_TEST_SANDBOX_CONTAINERS === "1")
  test("agent commands retain drive context across Node and Python sandboxes and isolate other drives", async () => {
    const fixture = await createEveFixture()
    const { context } = fixture
    const database = context.database
    const execute = promisify(execFile)
    try {
      const drive = await createDrive(context, {
        name: "Shared research",
        provider: "local",
      })
      const isolated = await createDrive(context, {
        name: "Separate context",
        provider: "local",
      })
      let agent = await createAgent(context, {
        name: "Research",
        configuration: {
          provider: "openai",
          model: "gpt-4.1-mini",
          guardrails: { jevCheckEnabled: false },
          sandbox: {
            enabled: true,
            provider: "local",
            workingDirectory: "/workspace/context",
            drives: [{ driveId: drive.id, mountPath: "/workspace/context" }],
          },
        },
      })
      const turn = async (command: string) => {
        fixture.provider((body) =>
          invokeTool(
            body,
            { command, timeout: 10 },
            "Command finished.",
            "bash shell command"
          )
        )
        return runAgentTurn(context, {
          agentId: agent.id,
          channel: "api",
          requestKey: randomUUID(),
          message: "Continue the project",
        })
      }
      const written = await turn(
        'node -e \'require("fs").writeFileSync("context.txt", "retained research"); require("fs").writeFileSync("/tmp/ephemeral", "temporary"); console.log(process.getuid())\''
      )
      expect(
        written.toolCalls.find((call) => call.actionId === "bash")?.output
      ).toMatchObject({ exitCode: 0, stdout: "65534\n" })
      agent = await updateAgent(context, agent.id, {
        expectedRevision: agent.currentRevision,
        configuration: {
          ...agent.configuration,
          sandbox: { ...agent.configuration.sandbox, environment: "python" },
        },
      })
      const read = await turn(
        'python3 -c \'from pathlib import Path; print(Path("context.txt").read_text()); print(Path("/tmp/ephemeral").exists())\''
      )
      expect(
        read.toolCalls.find((call) => call.actionId === "bash")?.output
      ).toMatchObject({ exitCode: 0, stdout: "retained research\nFalse\n" })
      expect(read.conversation.id).not.toBe(written.conversation.id)
      agent = await createAgent(context, {
        name: "Another research assistant",
        configuration: agent.configuration,
      })
      const shared = await turn("cat context.txt")
      expect(
        shared.toolCalls.find((call) => call.actionId === "bash")?.output
      ).toMatchObject({ exitCode: 0, stdout: "retained research" })
      const isolatedConfig = {
        ...agent.configuration.sandbox,
        drives: [{ driveId: isolated.id, mountPath: "/workspace/context" }],
      }
      expect(
        await runAgentSandboxCommand(context, isolatedConfig, {
          command: "test ! -e context.txt && echo isolated",
        })
      ).toMatchObject({ exitCode: 0, stdout: "isolated\n" })
      await database.execute(
        sql`UPDATE build_drives SET lease_token = ${randomUUID()}, lease_until = now() + interval '5 minutes' WHERE id = ${drive.id}::uuid`
      )
      await rejects(
        runAgentSandboxCommand(context, agent.configuration.sandbox, {
          command: "echo should-not-run",
        }),
        /busy/
      )
      await database.execute(
        sql`UPDATE build_drives SET lease_until = now() - interval '1 second' WHERE id = ${drive.id}::uuid`
      )
      expect(
        await runAgentSandboxCommand(context, agent.configuration.sandbox, {
          command: "echo recovered",
        })
      ).toMatchObject({ exitCode: 0, stdout: "recovered\n" })
      expect(
        await runAgentSandboxCommand(context, isolatedConfig, {
          command: "sleep 3",
          timeoutSeconds: 1,
        })
      ).toMatchObject({ exitCode: 124 })
      expect(
        await runAgentSandboxCommand(context, isolatedConfig, {
          command: "python3 -c 'print(\"x\" * 40000)'",
        })
      ).toMatchObject({ exitCode: 0, truncated: true })
      const extra = await Promise.all(
        ["Reports", "Code"].map((name) =>
          createDrive(context, { name, provider: "local" })
        )
      )
      const fourDrives = {
        ...agent.configuration.sandbox,
        drives: [drive, isolated, ...extra].map((item, index) => ({
          driveId: item.id,
          mountPath: `/workspace/drive-${index}`,
        })),
        workingDirectory: "/workspace/drive-0",
      }
      expect(
        await runAgentSandboxCommand(context, fourDrives, {
          command:
            "for n in 0 1 2 3; do echo $n > /workspace/drive-$n/number; done",
        })
      ).toMatchObject({ exitCode: 0 })
      expect(
        await runAgentSandboxCommand(context, fourDrives, {
          command: "cat /workspace/drive-*/number",
        })
      ).toMatchObject({ exitCode: 0, stdout: "0\n1\n2\n3\n" })
      const removed = await execute("docker", [
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `label=datool.drive=${isolated.id}`,
      ])
      await execute("docker", ["volume", "rm", removed.stdout.trim()])
      await rejects(
        runAgentSandboxCommand(context, isolatedConfig, {
          command: "echo must-not-recreate",
        }),
        /no such volume/i
      )
    } finally {
      const volumes = await execute("docker", [
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `label=datool.project=${context.projectId}`,
      ])
      for (const volume of volumes.stdout.trim().split("\n").filter(Boolean))
        await execute("docker", ["volume", "rm", volume])
      await fixture.close()
    }
  }, 120_000)
