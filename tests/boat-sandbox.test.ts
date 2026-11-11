import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { sql } from "drizzle-orm"
import { boatFixture } from "./helpers/boat"
import { storageFixture } from "./helpers/drive-storage"
import {
  createEveFixture,
  eveResponse,
  toolOutputs,
} from "./helpers/eve-fixture"
import { BoatClient, BoatDocker } from "@/src/server/sandbox/boat"
import { executeSandboxProvider } from "@/src/server/sandbox/provider-runtime"
import { encryptProviderKey } from "@/src/server/model-providers/secrets"
import { saveStorageConnection } from "@/src/server/build/storage/connections"
import {
  cloudDriveFiles,
  loadCloudDrive,
} from "@/src/server/build/storage/files"
import { createDrive } from "@/src/server/build/drives"
import { createAgent } from "@/src/server/build/agents"
import { runAgentTurn } from "@/src/server/build/runtime"
import { runAgentSandboxCommand } from "@/src/server/build/sandbox-runtime"
import { agentSandboxSchema } from "@/src/lib/build/sandbox"

// Owns the new transport/lifecycle boundary: API emulation drives real isolated
// containers and object storage. Existing local tests cannot detect UTF-8 file
// corruption, lost Boat receipts, or snapshot recovery against the wrong VM.
test("Boat preserves bytes, isolation and pending drive recovery through fresh VMs and Eve", async () => {
  const boat = await boatFixture()
  let storage: Awaited<ReturnType<typeof storageFixture>> | undefined
  let eve: Awaited<ReturnType<typeof createEveFixture>> | undefined
  try {
    storage = await storageFixture("s3")
    eve = await createEveFixture({ upstream: boat.request })
    const { context } = eve
    const client = new BoatClient("boat_fixture_secret")
    const key = randomUUID()
    boat.faults.loseNextCreate()
    const same = await client.create(key, true)
    expect(await client.create(key, true)).toBe(same)
    expect(boat.boxes.size).toBe(1)
    const transport = new BoatDocker(client, same)
    await transport.prepare("node:22-bookworm-slim")
    const binary = Buffer.alloc(1024 * 1024 + 17)
    for (let i = 0; i < binary.length; i++) binary[i] = i % 256
    const echo = transport.spawn(
      [
        "run",
        "--rm",
        "--network=none",
        "-i",
        "node:22-bookworm-slim",
        "node",
        "-e",
        "process.stdin.pipe(process.stdout); process.stderr.write('separate stderr ✓')",
      ],
      true
    )
    const writer = echo.stdin!.getWriter()
    const writing = (async () => {
      await writer.write(binary)
      await writer.close()
    })()
    const [bytes, stderr, transportResult] = await Promise.all([
      new Response(echo.stdout).arrayBuffer(),
      new Response(echo.stderr).text(),
      echo.wait(),
      writing,
    ])
    expect(Buffer.from(bytes)).toEqual(binary)
    expect(stderr).toBe("separate stderr ✓")
    expect(transportResult.exitCode).toBe(0)
    await client.stop(same)
    await rejects(client.get("bx_missing"), (error) => {
      expect(String(error)).not.toContain("boat_fixture_secret")
      return true
    })
    const credentials = encryptProviderKey(
      JSON.stringify({ provider: "boat", apiKey: "boat_fixture_secret" }),
      context.projectId,
      "sandbox:boat"
    )
    await context.database.execute(
      sql`INSERT INTO project_sandbox_settings(project_id,providers,default_provider) VALUES(${context.projectId},${JSON.stringify({ boat: credentials })}::jsonb,'boat')`
    )
    const connection = await saveStorageConnection(context, storage.input)
    const drive = await createDrive(context, {
      name: "Boat files",
      provider: "s3",
      storageConnectionId: connection.id,
    })
    const sandbox = agentSandboxSchema.parse({
      enabled: true,
      provider: "boat",
      drives: [{ driveId: drive.id, mountPath: "/workspace" }],
    })
    const command = (command: string) =>
      runAgentSandboxCommand(context, sandbox, { command, timeoutSeconds: 15 })
    const data = Buffer.from([0, 255, 128, 10, 13, 65, 195, 167])
    await cloudDriveFiles(context, drive.id, {
      action: "write",
      path: "bytes.bin",
      content: data.toString("base64"),
    })
    const isolation = await command(
      "id -u; cat /sys/class/net/eth0/address 2>/dev/null || echo no-network; test ! -e /var/run/docker.sock && echo no-socket; test -z \"$BOAT_API_KEY\" && echo no-key; printf 'ação ✓' > note.txt; base64 -w0 bytes.bin"
    )
    expect(isolation.exitCode).toBe(0)
    expect(isolation.stdout).toBe(
      `65534\nno-network\nno-socket\nno-key\n${data.toString("base64")}`
    )
    const file = async (path: string) =>
      (await cloudDriveFiles(context, drive.id, { action: "read", path })) as {
        content: string
      }
    expect(
      Buffer.from((await file("note.txt")).content, "base64").toString()
    ).toBe("ação ✓")
    const head = (await loadCloudDrive(context, drive.id)).head_revision
    boat.faults.failNextCapture()
    await rejects(
      command("printf 'recover me' > note.txt"),
      /Boat command failed/
    )
    const pending = await loadCloudDrive(context, drive.id)
    expect(pending).toMatchObject({
      sync_pending: true,
      head_revision: head,
      sync_compute_provider: "boat",
    })
    expect(pending.sync_compute_id).not.toBeNull()
    await context.database.execute(
      sql`UPDATE build_drives SET lease_until=now()-interval '1 second' WHERE id=${drive.id}::uuid`
    )
    expect((await command("cat note.txt")).stdout).toBe("recover me")
    expect((await loadCloudDrive(context, drive.id)).sync_pending).toBe(false)

    const agent = await createAgent(context, {
      name: "Boat native files",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        guardrails: { jevCheckEnabled: false },
        sandbox,
      },
    })
    eve.provider((body) => {
      const outputs = toolOutputs(body)
      if (!outputs.length)
        return eveResponse(body, "", {
          name: "eve__tool",
          input: {
            name: "write_file",
            input: { filePath: "native.txt", content: "Boat native files ✓" },
          },
        })
      if (outputs.length === 1)
        return eveResponse(body, "", {
          name: "eve__tool",
          input: { name: "read_file", input: { filePath: "native.txt" } },
        })
      expect(JSON.stringify(outputs)).toContain("Boat native files ✓")
      return eveResponse(body, "Saved on Boat.")
    })
    const result = await runAgentTurn(context, {
      agentId: agent.id,
      channel: "api",
      requestKey: randomUUID(),
      message: "Write and read the native file",
    })
    expect(
      result.toolCalls
        .filter((call) => ["write_file", "read_file"].includes(call.actionId))
        .map((call) => call.status)
    ).toEqual(["completed", "completed"])
    expect(
      Buffer.from((await file("native.txt")).content, "base64").toString()
    ).toBe("Boat native files ✓")
    expect(
      [...boat.boxes.values()].every((box) => box.state === "archived")
    ).toBe(true)
  } finally {
    await eve?.close()
    await storage?.close()
    await boat.close()
  }
}, 240_000)

test("Boat scorers execute both languages and stop after timeouts", async () => {
  const boat = await boatFixture()
  try {
    for (const [language, code] of [
      [
        "javascript",
        "function evaluate() { return {score: 0.75, reason: 'ação'} }",
      ],
      [
        "python",
        'def evaluate(trace, dataset_item=None):\n return {"score":0.75,"reason":"ação"}',
      ],
    ] as const) {
      expect(
        await executeSandboxProvider(
          { provider: "boat", apiKey: "boat_fixture_secret" },
          {
            language,
            timeoutMs: 1000,
            payload: JSON.stringify({
              code,
              timeoutMs: 1000,
              trace: { input: "a", output: "a" },
            }),
          }
        )
      ).toMatchObject({ score: 0.75, reasoning: "ação" })
    }
    expect(
      (
        await executeSandboxProvider(
          { provider: "boat", apiKey: "boat_fixture_secret" },
          {
            language: "javascript",
            timeoutMs: 100,
            payload: JSON.stringify({
              code: "function evaluate() { while(true) {} }",
              timeoutMs: 100,
              trace: {},
            }),
          }
        )
      ).error?.kind
    ).toBe("timeout")
    expect(
      (
        await executeSandboxProvider(
          { provider: "boat", apiKey: "boat_fixture_secret" },
          {
            language: "python",
            timeoutMs: 1000,
            payload: JSON.stringify({
              code: 'print("x" * 40000)',
              timeoutMs: 1000,
              trace: {},
            }),
          }
        )
      ).error?.kind
    ).toBe("sandbox")
    expect(
      [...boat.boxes.values()].every(
        (box) => box.state === "archived" && !box.snapshots
      )
    ).toBe(true)
  } finally {
    await boat.close()
  }
}, 90_000)
