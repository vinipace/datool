import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import { pack } from "tar-stream"
import {
  createTracerFixture,
  closeTracerFixture,
  reopenTracerFixture,
} from "./helpers/tracer-fixture"
import {
  getTracerProjectId,
  registerTracerProjectId,
  closeTracerDatabase,
} from "@/src/server/tracer/db"
import { storageFixture } from "./helpers/drive-storage"
import {
  saveStorageConnection,
  listStorageConnections,
  removeStorageConnection,
} from "@/src/server/build/storage/connections"
import { createDrive, resolveSandboxDrives } from "@/src/server/build/drives"
import {
  cloudDriveFiles,
  exportCloudDrive,
  importCloudDrive,
  listDriveVersions,
  restoreDriveVersion,
  withDriveLease,
} from "@/src/server/build/storage/files"
import {
  runAgentSandboxCommand,
  volumeName,
} from "@/src/server/build/sandbox-runtime"
import { agentSandboxSchema } from "@/src/lib/build/sandbox"
import { boundedBytes } from "@/src/server/build/storage/objects"

// Protect actual bytes across API edits, native Docker filesystems, cache loss,
// version restore and failed synchronization. Neither storage adapter is mocked.
for (const provider of ["s3", "gcs"] as const)
  test(`${provider} drives persist independently of Docker and fail closed on unsafe or interrupted transfers`, async () => {
    const database = await createTracerFixture()
    const context = { database, projectId: getTracerProjectId(database) }
    const fixture = await storageFixture(provider)
    const volumes: string[] = []
    const docker = promisify(execFile)
    try {
      const connection = await saveStorageConnection(context, fixture.input)
      expect(
        JSON.stringify(await listStorageConnections(context))
      ).not.toContain("fixture-secret-key")
      const stored = await database.execute<{ encrypted_credentials: string }>(
        sql`SELECT encrypted_credentials FROM build_storage_connections WHERE id=${connection.id}::uuid`
      )
      expect(stored.rows[0].encrypted_credentials).not.toContain("fixture")
      await rejects(
        saveStorageConnection(context, {
          ...fixture.input,
          id: connection.id,
          expectedRevision: connection.revision,
          config: { ...fixture.input.config, bucket: "different-bucket" },
        }),
        /cannot change/
      )
      const drive = await createDrive(context, {
        name: "Files",
        provider,
        storageConnectionId: connection.id,
      })
      await rejects(
        removeStorageConnection(context, connection.id),
        /used by a drive/
      )
      const config = agentSandboxSchema.parse({
        enabled: true,
        provider: "local",
        drives: [{ driveId: drive.id, mountPath: "/workspace" }],
      })
      // Object storage and compute are separate; native volumes retain their binding.
      expect(
        (
          await resolveSandboxDrives(context, { ...config, provider: "modal" })
        )[0].id
      ).toBe(drive.id)
      const file = async (path: string) =>
        (await cloudDriveFiles(context, drive.id, {
          action: "read",
          path,
        })) as { content: string }
      await cloudDriveFiles(context, drive.id, {
        action: "write",
        path: "notes/hello.txt",
        content: Buffer.from("first\n").toString("base64"),
      })
      const original = (await listDriveVersions(context, drive.id)).items[0].id
      await withDriveLease(context, drive.id, async () => {
        await rejects(
          cloudDriveFiles(context, drive.id, {
            action: "write",
            path: "notes/race.txt",
            content: "Yg==",
          }),
          /busy/
        )
        await rejects(
          runAgentSandboxCommand(context, config, {
            command: "echo forbidden",
          }),
          /busy/
        )
      })
      const foreignProject = crypto.randomUUID()
      await database.execute(
        sql`INSERT INTO project(id,organization_id,name,slug) SELECT ${foreignProject},organization_id,'Foreign',${foreignProject} FROM project WHERE id=${context.projectId}`
      )
      const foreignDb = registerTracerProjectId(
        reopenTracerFixture(database),
        foreignProject
      )
      const foreign = { database: foreignDb, projectId: foreignProject }
      try {
        const shared = await createDrive(foreign, {
          name: "Shared connection, separate files",
          provider,
          storageConnectionId: connection.id,
        })
        expect(shared.id).not.toBe(drive.id)
        expect(
          (await listStorageConnections(foreign)).items.map((row) => row.id)
        ).toContain(connection.id)
        await rejects(
          cloudDriveFiles(foreign, shared.id, {
            action: "read",
            path: "notes/hello.txt",
          }),
          /not found/i
        )
        await rejects(
          cloudDriveFiles(foreign, drive.id, {
            action: "read",
            path: "notes/hello.txt",
          }),
          /unavailable/
        )
        await rejects(
          exportCloudDrive(foreign, drive.id, original),
          /unavailable/
        )
      } finally {
        await closeTracerDatabase(foreignDb)
      }
      volumes.push(volumeName(context.projectId, drive.id))
      const run = await runAgentSandboxCommand(context, config, {
        command:
          "cat /workspace/notes/hello.txt; printf 'from Docker' > /workspace/output.txt",
      })
      expect(run.exitCode).toBe(0)
      expect(run.stdout).toBe("first\n")
      expect(
        Buffer.from((await file("output.txt")).content, "base64").toString()
      ).toBe("from Docker")
      // The native volume is disposable for cloud drives: a fresh cache hydrates bytes.
      await docker("docker", ["volume", "rm", volumes[0]])
      const fresh = await runAgentSandboxCommand(context, config, {
        command: "cat /workspace/output.txt",
      })
      expect(fresh.stdout).toBe("from Docker")
      expect(fresh.exitCode).toBe(0)
      const current = (await listDriveVersions(context, drive.id)).items.find(
        (item) => item.current
      )!.id
      await rejects(
        restoreDriveVersion(context, drive.id, original, original),
        /changed/
      )
      const restored = await restoreDriveVersion(
        context,
        drive.id,
        original,
        current
      )
      expect(
        Buffer.from(
          (await file("notes/hello.txt")).content,
          "base64"
        ).toString()
      ).toBe("first\n")
      await rejects(file("output.txt"), /not found/)
      const archive = await exportCloudDrive(context, drive.id)
      const copy = await createDrive(context, {
        name: "Restored copy",
        provider,
        storageConnectionId: connection.id,
      })
      await importCloudDrive(context, copy.id, archive, null)
      const copied = (await cloudDriveFiles(context, copy.id, {
        action: "read",
        path: "notes/hello.txt",
      })) as { content: string }
      expect(copied.content).toBe(Buffer.from("first\n").toString("base64"))
      // Reject unsafe archive entries before changing the committed head.
      for (const header of [
        { name: "../escape", type: "file" as const, size: 1 },
        {
          name: "link",
          type: "symlink" as const,
          linkname: "/etc/passwd",
          size: 0,
        },
      ]) {
        const writer = pack()
        const output = boundedBytes(writer)
        writer.entry(header, header.size ? Buffer.from("x") : Buffer.alloc(0))
        writer.finalize()
        await rejects(
          importCloudDrive(context, drive.id, await output, restored.revision),
          /relative path|regular files/
        )
      }
      expect(
        (await listDriveVersions(context, drive.id)).items.find(
          (item) => item.current
        )?.id
      ).toBe(restored.revision)
      // Crash during initial hydration: partial cache bytes are never a new version.
      await docker("docker", [
        "run",
        "--rm",
        "--network=none",
        "--user=65534:65534",
        "-v",
        `${volumes[0]}:/drive`,
        "node:22-bookworm-slim",
        "sh",
        "-c",
        "rm -rf /drive/*; printf partial > /drive/incomplete",
      ])
      await database.execute(
        sql`UPDATE build_drives SET sync_pending=true,sync_hydrating=true,sync_compute_provider='local',lease_token=${crypto.randomUUID()}::uuid,lease_until=now()-interval '1 second' WHERE id=${drive.id}::uuid`
      )
      const hydrated = await runAgentSandboxCommand(context, config, {
        command:
          "cat /workspace/notes/hello.txt; test ! -e /workspace/incomplete",
      })
      expect(hydrated.stdout).toBe("first\n")
      expect(hydrated.exitCode).toBe(0)
      const beforeFailure = (
        await listDriveVersions(context, drive.id)
      ).items.find((item) => item.current)!.id
      // Checkpoint failure must retain the last version and prevent silent cache loss.
      await rejects(
        runAgentSandboxCommand(context, config, {
          command:
            "ln -s /etc/passwd /workspace/unsupported; printf 'recover me' > /workspace/pending.txt",
        }),
        /regular files/
      )
      expect(
        (await listDriveVersions(context, drive.id)).items.find(
          (item) => item.current
        )?.id
      ).toBe(beforeFailure)
      await rejects(
        cloudDriveFiles(context, drive.id, {
          action: "write",
          path: "overwrite",
          content: "YQ==",
        }),
        /awaiting synchronization/
      )
      // An operator removes the unsupported file from the stopped cache. The expired
      // lease then recovers pending bytes before another run can hydrate over them.
      await docker("docker", [
        "run",
        "--rm",
        "--network=none",
        "-v",
        `${volumes[0]}:/drive`,
        "node:22-bookworm-slim",
        "rm",
        "/drive/unsupported",
      ])
      await database.execute(
        sql`UPDATE build_drives SET lease_until=now()-interval '1 second' WHERE id=${drive.id}::uuid`
      )
      const recovered = await runAgentSandboxCommand(context, config, {
        command: "cat /workspace/pending.txt",
      })
      expect(recovered.stdout).toBe("recover me")
      expect(
        Buffer.from((await file("pending.txt")).content, "base64").toString()
      ).toBe("recover me")
    } finally {
      for (const volume of volumes)
        await docker("docker", ["volume", "rm", volume]).catch(() => undefined)
      await fixture.close()
      await closeTracerFixture(database)
    }
  }, 180000)

import {
  createEveFixture,
  eveResponse,
  toolOutputs,
} from "./helpers/eve-fixture"
import { createAgent, updateAgent } from "@/src/server/build/agents"
import {
  createChannelConnection,
  updateChannelStatus,
} from "@/src/server/build/channels/service"
import {
  resolveSdkDrive,
  createSdkSession,
  requireSdkSession,
} from "@/src/server/build/sdk-scope"
import { sdkFiles } from "@/src/server/build/sdk-files"
import { runAgentTurn } from "@/src/server/build/runtime"

test("SDK workspace storage survives compute changes and Eve acknowledges only committed files", async () => {
  const storage = await storageFixture("s3")
  const eve = await createEveFixture()
  const { context } = eve
  let driveId: string | null = null
  try {
    const connection = await saveStorageConnection(context, storage.input)
    const agent = await createAgent(context, {
      name: "Portable SDK",
      configuration: {
        provider: "openai",
        model: "gpt-4.1-mini",
        guardrails: { jevCheckEnabled: false },
        sandbox: {
          enabled: true,
          provider: "local",
          sdkStorageConnectionId: connection.id,
        },
      },
    })
    const channel = await createChannelConnection(context, {
      agentId: agent.id,
      channel: "api",
      label: "SDK",
    })
    await updateChannelStatus(context, channel.id, "connected")
    const scope = { connectionId: channel.id, userId: "alice", drive: "acme" }
    const sessions = await Promise.all([
      createSdkSession(context, scope),
      createSdkSession(context, { ...scope, userId: "bob" }),
    ])
    driveId = (
      await requireSdkSession(context, scope, sessions[0].conversationId)
    ).driveId
    expect(driveId).not.toBeNull()
    expect(
      (
        await requireSdkSession(
          context,
          { ...scope, userId: "bob" },
          sessions[1].conversationId
        )
      ).driveId
    ).toBe(driveId)
    expect(
      await resolveSdkDrive(context, scope, {
        ...agent.configuration.sandbox,
        provider: "modal",
      })
    ).toBe(driveId)
    await rejects(
      resolveSdkDrive(context, scope, {
        ...agent.configuration.sandbox,
        sdkStorageConnectionId: undefined,
      }),
      /migrate/
    )
    await rejects(
      sdkFiles(context, {
        ...scope,
        request: { action: "read", path: "missing.txt" },
      }),
      (error) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "VALIDATION_ERROR" &&
        error.message === "File or directory not found."
    )
    await sdkFiles(context, {
      ...scope,
      request: {
        action: "write",
        path: "sdk.txt",
        content: Buffer.from("SDK bytes").toString("base64"),
      },
    })
    const native = await promisify(execFile)("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=datool.drive=${driveId}`,
    ])
    expect(native.stdout.trim()).toBe("") // File API did not allocate a sandbox/cache.
    await updateAgent(context, agent.id, {
      expectedRevision: agent.currentRevision,
      apply: true,
      configuration: {
        ...agent.configuration,
        sandbox: {
          ...agent.configuration.sandbox,
          drives: [{ driveId: driveId!, mountPath: "/workspace" }],
        },
      },
    })
    let unsafe = false
    eve.provider((body) =>
      toolOutputs(body).length
        ? eveResponse(body, "Files saved.")
        : eveResponse(body, "", {
            name: "eve__tool",
            input: unsafe
              ? {
                  name: "bash",
                  input: { command: "ln -s /etc/passwd /workspace/link" },
                }
              : {
                  name: "write_file",
                  input: { filePath: "agent.txt", content: "agent bytes" },
                },
          })
    )
    const result = await runAgentTurn(context, {
      agentId: agent.id,
      channel: "api",
      requestKey: crypto.randomUUID(),
      message: "Write the file",
    })
    expect(result.turn.status).toBe("completed")
    const synced = await context.database.execute(
      sql`SELECT d.sync_pending,d.sync_hydrating,d.lease_token,s.status,s.id FROM build_drives d LEFT JOIN build_agent_sandboxes s ON s.id=d.lease_token WHERE d.id=${driveId}::uuid`
    )
    expect(synced.rows[0]).toMatchObject({
      sync_pending: false,
      lease_token: null,
    })
    expect(
      await sdkFiles(context, {
        ...scope,
        request: { action: "read", path: "agent.txt" },
      })
    ).toEqual({ content: Buffer.from("agent bytes").toString("base64") })
    const revision = (await listDriveVersions(context, driveId!)).items.find(
      (item) => item.current
    )!.id
    unsafe = true
    await rejects(
      runAgentTurn(context, {
        agentId: agent.id,
        channel: "api",
        requestKey: crypto.randomUUID(),
        message: "Write an unsupported link",
      }),
      /did not complete|Eve execution request failed/
    )
    const failed = await context.database.execute<{
      status: string
      outcome_json: { error: { code: string } }
    }>(
      sql`SELECT status,outcome_json FROM build_eve_executions WHERE project_id=${context.projectId} AND outcome_json->'error'->>'code'='DRIVE_SYNC_FAILED'`
    )
    expect(failed.rows[0]).toMatchObject({
      status: "failed",
      outcome_json: { error: { code: "DRIVE_SYNC_FAILED" } },
    })
    expect(
      (await listDriveVersions(context, driveId!)).items.find(
        (item) => item.current
      )?.id
    ).toBe(revision)
  } finally {
    await eve.close()
    if (driveId)
      await promisify(execFile)("docker", [
        "volume",
        "rm",
        volumeName(context.projectId, driveId),
      ]).catch(() => undefined)
    await storage.close()
  }
}, 180000)
