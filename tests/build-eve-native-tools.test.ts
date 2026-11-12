import { updateOrganizationSandboxSettings } from "@/src/server/sandbox/providers-store"
import { projectProviderContext } from "@/src/server/providers/context"
import { expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import {
  createEveFixture,
  eveResponse,
  toolOutputs,
} from "./helpers/eve-fixture"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import { createDrive } from "@/src/server/build/drives"
import { runAgentTurn } from "@/src/server/build/runtime"

const configuration = {
  provider: "openai" as const,
  model: "gpt-4.1-mini",
  guardrails: { jevCheckEnabled: false },
}

test("a removed sandbox provider produces an actionable file-tool failure", async () => {
  const fixture = await createEveFixture()
  const { context } = fixture
  try {
    const agent = await createAgent(context, {
      name: "Provider removed",
      configuration: {
        ...configuration,
        sandbox: { enabled: true, provider: "local" },
      },
    })
    await updateOrganizationSandboxSettings(
      await projectProviderContext(context.projectId, context.database),
      { type: "remove", provider: "local" }
    )
    fixture.provider((body) =>
      toolOutputs(body).length
        ? eveResponse(body, "The sandbox provider needs configuration.")
        : eveResponse(body, "", {
            name: "eve__tool",
            input: {
              name: "write_file",
              input: { filePath: "poem.txt", content: "A little light." },
            },
          })
    )
    const result = await runAgentTurn(context, {
      agentId: agent.id,
      channel: "api",
      requestKey: randomUUID(),
      message: "Create a poem text file",
    })
    expect(
      result.toolCalls.find((call) => call.actionId === "write_file")
    ).toMatchObject({
      status: "failed",
      output: {
        error:
          "Local container is not configured for this organization. Configure it in Organization settings → Sandbox providers, or select a configured provider for this agent.",
      },
    })
    expect(
      (
        await context.database.execute(
          sql`SELECT id FROM build_agent_sandboxes WHERE turn_id=${result.turn.id}`
        )
      ).rows
    ).toHaveLength(0)
  } finally {
    await fixture.close()
  }
}, 30_000)

// Owns the native Eve/provider boundary, including restrictions applied before
// provider-executed search. Only upstream web/model HTTP responses are synthetic.
test("published web controls govern native fetch and search independently of the sandbox", async () => {
  let fetched = 0
  const fixture = await createEveFixture({
    upstream: async (url) => {
      expect(String(url)).toBe("https://mcp.example.com/research")
      fetched++
      return new Response(
        "<html><body><h1>Public research</h1><p>Source verified.</p></body></html>",
        { headers: { "content-type": "text/html" } }
      )
    },
  })
  const { context } = fixture
  try {
    let agent = await createAgent(context, {
      name: "Web research",
      configuration,
    })
    const turn = () =>
      runAgentTurn(context, {
        agentId: agent.id,
        channel: "api",
        requestKey: randomUUID(),
        message: "Research this page",
      })
    fixture.provider((body) => {
      expect(JSON.stringify(body.tools ?? [])).not.toContain(
        '"type":"web_search"'
      )
      expect(JSON.stringify(body.tools ?? [])).not.toContain("eve__search")
      return eveResponse(body, "No web access.")
    })
    await turn()
    expect(fetched).toBe(0)
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      configuration: {
        ...agent.configuration,
        web: { fetchEnabled: true, searchEnabled: true },
      },
      apply: false,
    })
    await turn()
    expect(fetched).toBe(0)
    agent = await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      apply: true,
    })
    fixture.provider((body) => {
      expect(JSON.stringify(body.tools ?? [])).toContain('"type":"web_search"')
      if (!toolOutputs(body).length)
        return eveResponse(body, "", {
          name: "eve__tool",
          input: {
            name: "web_fetch",
            input: { url: "https://mcp.example.com/research", format: "text" },
          },
        })
      expect(JSON.stringify(toolOutputs(body))).toContain("Source verified")
      return eveResponse(body, "Source verified.")
    })
    const result = await turn()
    expect(result.text).toBe("Source verified.")
    expect(fetched).toBe(1)
    expect(result.toolCalls.some((call) => call.actionId === "web_fetch")).toBe(
      true
    )
    expect(
      (
        await context.database.execute(
          sql`SELECT id FROM build_agent_sandboxes WHERE project_id=${context.projectId}`
        )
      ).rows
    ).toHaveLength(0)

    fixture.provider((body) => {
      if (toolOutputs(body).length) {
        expect(JSON.stringify(toolOutputs(body))).toContain("private")
        return eveResponse(body, "Private URL blocked.")
      }
      return eveResponse(body, "", {
        name: "eve__tool",
        input: {
          name: "web_fetch",
          input: { url: "https://127.0.0.1:19432/private" },
        },
      })
    })
    const blocked = await turn()
    expect(
      blocked.toolCalls.find((call) => call.actionId === "web_fetch")?.status
    ).toBe("failed")
    expect(fetched).toBe(1)

    fixture.provider(async (body, request) => {
      expect(request.headers.authorization).toBe("Bearer eve-project-key")
      expect(JSON.stringify(body.tools ?? [])).toContain('"type":"web_search"')
      const response = await eveResponse(body, "Search source verified.").text()
      const events = response
        .split("\n\n")
        .filter(Boolean)
        .map((event) => JSON.parse(event.split("\ndata: ")[1]))
      for (const event of events)
        if ("output_index" in event) event.output_index++
      const id = `ws_${randomUUID()}`
      events.splice(
        1,
        0,
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "web_search_call", id, status: "in_progress" },
        },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: {
            type: "web_search_call",
            id,
            status: "completed",
            action: {
              type: "search",
              query: "Public research",
              sources: [{ type: "url", url: "https://example.com/research" }],
            },
          },
        }
      )
      return new Response(
        events
          .map(
            (event, sequence_number) =>
              `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`
          )
          .join(""),
        { headers: { "content-type": "text/event-stream" } }
      )
    })
    const searched = await turn()
    expect(searched.text).toBe("Search source verified.")
    expect(
      searched.toolCalls.find((call) => call.actionId === "web_search")
    ).toMatchObject({
      status: "completed",
      output: { action: { type: "search", query: "Public research" } },
    })
  } finally {
    await fixture.close()
  }
}, 60_000)

// Actual native file tools and background processes must share a container after
// a hard Eve restart. This catches a command-by-command adapter masquerading as
// a session, missing native tool registration, and cleanup that loses drive data.
if (process.env.DATOOL_TEST_SANDBOX_CONTAINERS === "1")
  test("native files and background shell work survive Eve restart and clean up after the turn", async () => {
    const fixture = await createEveFixture()
    const { context } = fixture
    const execute = promisify(execFile)
    let release: (() => void) | undefined
    try {
      const drive = await createDrive(context, {
        name: "Native work",
        provider: "local",
      })
      const agent = await createAgent(context, {
        name: "Native tools",
        configuration: {
          ...configuration,
          sandbox: {
            enabled: true,
            provider: "local",
            workingDirectory: "/workspace/files",
            drives: [{ driveId: drive.id, mountPath: "/workspace/files" }],
          },
        },
      })
      const steps = [
        {
          name: "write_file",
          input: {
            filePath: "notes with spaces.txt",
            content: "first draft\n",
          },
        },
        { name: "read_file", input: { filePath: "notes with spaces.txt" } },
        {
          name: "edit_file",
          input: {
            path: "notes with spaces.txt",
            edits: [{ oldText: "first draft", newText: "verified draft" }],
          },
        },
        { name: "glob", input: { pattern: "**/*.txt" } },
        { name: "grep", input: { pattern: "verified", outputMode: "content" } },
        {
          name: "bash",
          input: {
            command: "sleep 3; printf 'background complete' > background.txt",
            timeout: 1,
          },
        },
        {
          name: "bash",
          input: {
            command:
              "for i in $(seq 1 30); do test -f background.txt && break; sleep 1; done; cat background.txt; cat 'notes with spaces.txt'; printf temporary > /tmp/ephemeral",
            timeout: 30,
          },
        },
      ]
      let notify!: () => void
      const reached = new Promise<void>((resolve) => {
        notify = resolve
      })
      let restarting = false
      fixture.provider(async (body) => {
        const index = toolOutputs(body).length
        expect(JSON.stringify(toolOutputs(body))).not.toContain('"error":')
        if (index === 6 && !restarting) {
          restarting = true
          notify()
          await new Promise<void>((resolve) => {
            release = resolve
          })
        }
        const step = steps[index]
        return step
          ? eveResponse(body, "", { name: "eve__tool", input: step })
          : eveResponse(body, "Native work finished.")
      })
      const pending = runAgentTurn(
        context,
        {
          agentId: agent.id,
          channel: "api",
          requestKey: randomUUID(),
          message: "Write and verify files",
        },
        { maxToolSteps: 16 }
      )
      pending.catch(() => notify())
      await Promise.race([
        reached,
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error("Native tools did not reach the restart checkpoint.")
              ),
            40_000
          )
        ),
      ])
      // Also cover recovery when the provider allocation exists but its
      // database activation receipt was not committed before the crash.
      await context.database.execute(
        sql`UPDATE build_agent_sandboxes SET status='creating' WHERE project_id=${context.projectId} AND status='running'`
      )
      await fixture.stop()
      release?.()
      await fixture.start()
      const result = await pending
      expect(result.text).toBe("Native work finished.")
      expect(
        result.toolCalls.filter((call) => call.actionId === "write_file")
      ).toHaveLength(1)
      expect(
        result.toolCalls.find((call) => call.actionId === "edit_file")?.output
      ).toMatchObject({ replacements: 1 })
      expect(
        JSON.stringify(
          result.toolCalls.find((call) => call.actionId === "glob")?.output
        )
      ).toContain("notes with spaces.txt")
      expect(
        JSON.stringify(
          result.toolCalls.find((call) => call.actionId === "grep")?.output
        )
      ).toContain("verified draft")
      expect(
        result.toolCalls.filter((call) => call.actionId === "bash")[0]?.output
      ).toMatchObject({ status: "running" })
      expect(
        JSON.stringify(
          result.toolCalls.filter((call) => call.actionId === "bash")[1]?.output
        )
      ).toContain("background completeverified draft")
      // Cleanup hooks may finish just after the reply projection becomes visible.
      for (let count = 0; count < 50; count++) {
        const rows = await context.database.execute<{ status: string }>(
          sql`SELECT status FROM build_agent_sandboxes WHERE turn_id=${result.turn.id}`
        )
        if (rows.rows[0]?.status === "closed") break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(
        (
          await context.database.execute<{ status: string }>(
            sql`SELECT status FROM build_agent_sandboxes WHERE turn_id=${result.turn.id}`
          )
        ).rows[0].status
      ).toBe("closed")
      expect(
        (
          await execute("docker", [
            "ps",
            "-aq",
            "--filter",
            `label=datool.turn=${result.turn.id}`,
          ])
        ).stdout.trim()
      ).toBe("")
      fixture.provider((body) =>
        toolOutputs(body).length
          ? eveResponse(body, "Drive retained.")
          : eveResponse(body, "", {
              name: "eve__tool",
              input: {
                name: "bash",
                input: {
                  command:
                    "cat 'notes with spaces.txt'; test ! -e /tmp/ephemeral",
                  timeout: 10,
                },
              },
            })
      )
      const next = await runAgentTurn(context, {
        agentId: agent.id,
        channel: "api",
        requestKey: randomUUID(),
        message: "Continue",
      })
      expect(next.toolCalls[0].output).toMatchObject({
        exitCode: 0,
        stdout: "verified draft\n",
      })
    } finally {
      release?.()
      const containers = await execute("docker", [
        "ps",
        "-aq",
        "--filter",
        `label=datool.project=${context.projectId}`,
      ])
      for (const id of containers.stdout.trim().split("\n").filter(Boolean))
        await execute("docker", ["rm", "-f", id])
      const volumes = await execute("docker", [
        "volume",
        "ls",
        "-q",
        "--filter",
        `label=datool.project=${context.projectId}`,
      ])
      for (const id of volumes.stdout.trim().split("\n").filter(Boolean))
        await execute("docker", ["volume", "rm", id])
      await fixture.close()
    }
  }, 100_000)
