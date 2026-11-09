import { execFile, spawn } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import type { Sandbox, ModalClient } from "modal"
import {
  agentSandboxSchema,
  sandboxCommandSchema,
  type AgentSandboxConfiguration,
  type SandboxCommandResult,
} from "@/src/lib/build/sandbox"
import { getSandboxProviderCredentials } from "@/src/server/sandbox/providers-store"
import { assertManagedProject } from "@/src/server/execution-credits/config"
import { executionCredits } from "@/src/server/execution-credits/ledger"
import { assertBuildProject, type BuildContext } from "./context"
import { resolveSandboxDrives } from "./drives"

const executeFile = promisify(execFile)
export const images = {
  node: "node:22-bookworm-slim",
  python: "python:3.13-slim",
}
export const RATE = 39_420 + 6_670 / 2 // 1 CPU + 512 MiB; observed allocated time.
export const RATE_VERSION = "datool-agent-modal-1cpu-512mib-2026-11-08"
type Mount = { id: string; mountPath: string; provisioned: boolean }
export class SandboxDriveBusyError extends Error {}

export async function markProvisioned(context: BuildContext, driveId: string) {
  await context.database.execute(sql`
    UPDATE build_drives SET provisioned_at = now()
    WHERE project_id = ${context.projectId} AND id = ${driveId}::uuid
  `)
}

export function volumeName(projectId: string, driveId: string) {
  return `datool-drive-${createHash("sha256").update(`${projectId}:${driveId}`).digest("hex").slice(0, 40)}`
}

type CommandIO = { stdin?: string; maxOutputBytes?: number }

function collector(limit = 32 * 1024) {
  let remaining = Math.min(limit, 1024 * 1024)
  let truncated = false
  const parts: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  }
  return {
    add(stream: "stdout" | "stderr", chunk: string | Buffer) {
      const bytes = Buffer.from(chunk)
      if (bytes.length > remaining) truncated = true
      if (!remaining) return
      parts[stream].push(bytes.subarray(0, remaining))
      remaining = Math.max(0, remaining - bytes.length)
    },
    result(exitCode: number): SandboxCommandResult {
      return {
        stdout: Buffer.concat(parts.stdout).toString("utf8"),
        stderr: Buffer.concat(parts.stderr).toString("utf8"),
        exitCode,
        truncated,
      }
    },
  }
}

async function drain(
  stream: ReadableStream<string>,
  add: (value: string) => void
) {
  const reader = stream.getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) return
      add(value)
    }
  } finally {
    reader.releaseLock()
  }
}

async function stopLocalContainer(docker: string, name: string) {
  try {
    await executeFile(docker, ["rm", "--force", name], { timeout: 10_000 })
  } catch (error) {
    if (
      !/No such container/i.test(String((error as { stderr?: string }).stderr))
    )
      throw error
  }
}

async function localCommand(
  context: BuildContext,
  config: AgentSandboxConfiguration,
  mounts: Mount[],
  command: string,
  timeout: number,
  stopped: () => void,
  signal?: AbortSignal,
  io: CommandIO = {}
) {
  const docker = process.env.DATOOL_SANDBOX_DOCKER_BINARY?.trim() || "docker"
  const projectId = context.projectId
  const image = images[config.environment]
  const names = mounts.map((mount) => ({
    ...mount,
    volume: volumeName(projectId, mount.id),
  }))
  for (const mount of names) {
    if (mount.provisioned) {
      // A missing drive is an error, never a new empty directory after host loss.
      await executeFile(docker, ["volume", "inspect", mount.volume], {
        timeout: 10_000,
        signal,
      })
    } else {
      await executeFile(
        docker,
        [
          "volume",
          "create",
          "--label",
          "datool.kind=agent-drive",
          "--label",
          `datool.project=${projectId}`,
          "--label",
          `datool.drive=${mount.id}`,
          mount.volume,
        ],
        { timeout: 10_000, signal }
      )
      await markProvisioned(context, mount.id)
    }
    // Initialize the managed volume's root for the unprivileged sandbox user.
    await executeFile(
      docker,
      [
        "run",
        "--rm",
        "--pull=never",
        "--network=none",
        "--read-only",
        "--cap-drop=ALL",
        "--cap-add=CHOWN",
        "--security-opt=no-new-privileges",
        "--mount",
        `type=volume,src=${mount.volume},dst=/drive`,
        image,
        "chown",
        "65534:65534",
        "/drive",
      ],
      { timeout: 15_000, signal }
    )
  }
  const name = `datool-agent-${randomUUID()}`
  const output = collector(io.maxOutputBytes)
  try {
    return await new Promise<SandboxCommandResult>((resolve, reject) => {
      const child = spawn(
        /* turbopackIgnore: true */ docker,
        [
          "run",
          ...(io.stdin !== undefined ? ["-i"] : []),
          "--rm",
          "--pull=never",
          "--name",
          name,
          "--init",
          ...(config.networkAccess ? [] : ["--network=none"]),
          "--read-only",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--user=65534:65534",
          "--cpus=1",
          "--memory=512m",
          "--memory-swap=512m",
          "--pids-limit=128",
          "--tmpfs=/tmp:rw,nosuid,size=128m,mode=1777",
          ...(names.some((mount) => mount.mountPath === "/workspace")
            ? []
            : ["--tmpfs=/workspace:rw,nosuid,size=128m,mode=1777"]),
          ...names.flatMap((mount) => [
            "--mount",
            `type=volume,src=${mount.volume},dst=${mount.mountPath},volume-nocopy`,
          ]),
          "--env=HOME=/tmp",
          "--workdir=/workspace",
          image,
          "/bin/sh",
          "-c",
          'mkdir -p "$1" && cd "$1" && exec timeout --signal=TERM --kill-after=2s "$2" /bin/sh -c "$3"',
          "datool",
          config.workingDirectory,
          `${timeout}s`,
          command,
        ],
        { stdio: ["pipe", "pipe", "pipe"], signal }
      )
      child.stdin.on("error", () => undefined)
      child.stdin.end(io.stdin)
      const timer = setTimeout(
        () => child.kill("SIGKILL"),
        (timeout + 20) * 1000
      )
      child.stdout.on("data", (chunk) => output.add("stdout", chunk))
      child.stderr.on("data", (chunk) => output.add("stderr", chunk))
      child.once("error", (error) => {
        clearTimeout(timer)
        reject(error)
      })
      child.once("close", (code) => {
        clearTimeout(timer)
        resolve(output.result(code ?? 137))
      })
    })
  } finally {
    // Removing the client process does not remove a running container.
    await stopLocalContainer(docker, name)
    stopped()
  }
}

async function modalCommand(
  context: BuildContext,
  config: AgentSandboxConfiguration,
  mounts: Mount[],
  command: string,
  timeout: number,
  stopped: () => void,
  signal?: AbortSignal,
  io: CommandIO = {}
) {
  let operation: string | undefined
  let sandbox: Sandbox | undefined
  let allocatedAt = 0
  let client: ModalClient | undefined
  let allocationRequested = false
  try {
    const { ModalClient } = await import("modal")
    let tokenId: string
    let tokenSecret: string
    if (config.provider === "datool") {
      await assertManagedProject(context.projectId, "sandbox")
      operation = await executionCredits.reserve(
        context.projectId,
        "sandbox",
        Math.ceil(180 * RATE),
        RATE_VERSION
      )
      tokenId = process.env.DATOOL_MODAL_TOKEN_ID!
      tokenSecret = process.env.DATOOL_MODAL_TOKEN_SECRET!
    } else {
      const credentials = await getSandboxProviderCredentials(
        context.projectId,
        "modal",
        context.database
      )
      if (credentials.provider !== "modal")
        throw new Error("Configure Modal in project Sandbox providers first.")
      tokenId = credentials.tokenId
      tokenSecret = credentials.tokenSecret
    }
    signal?.throwIfAborted()
    client = new ModalClient({
      tokenId,
      tokenSecret,
      timeoutMs: 15_000,
      maxRetries: 0,
    })
    const app = await client.apps.fromName("datool-agents", {
      createIfMissing: true,
    })
    const volumes: Record<
      string,
      Awaited<ReturnType<typeof client.volumes.fromName>>
    > = {}
    for (const mount of mounts) {
      volumes[mount.mountPath] = await client.volumes.fromName(
        volumeName(context.projectId, mount.id),
        { createIfMissing: !mount.provisioned }
      )
      if (!mount.provisioned) await markProvisioned(context, mount.id)
    }
    signal?.throwIfAborted()
    allocationRequested = true
    sandbox = await client.sandboxes.create(
      app,
      client.images.fromRegistry(images[config.environment]),
      {
        volumes,
        workdir: "/",
        timeoutMs: 120_000,
        blockNetwork: !config.networkAccess,
        cpu: 1,
        cpuLimit: 1,
        memoryMiB: 512,
        memoryLimitMiB: 512,
        command: ["/bin/sh", "-c", "trap 'exit 0' TERM INT; sleep 120 & wait"],
      }
    )
    allocatedAt = performance.now()
    if (operation)
      await executionCredits.recordEvidence(operation, sandbox.sandboxId, {
        allocationStartedAt: new Date().toISOString(),
      })
    signal?.throwIfAborted()
    const output = collector(io.maxOutputBytes)
    const commandProcess = await sandbox.exec(
      [
        "/bin/sh",
        "-c",
        'mkdir -p "$1" && cd "$1" && exec timeout --signal=TERM --kill-after=2s "$2" /bin/sh -c "$3"',
        "datool",
        config.workingDirectory,
        `${timeout}s`,
        command,
      ],
      { timeoutMs: (timeout + 5) * 1000 }
    )
    if (io.stdin !== undefined) {
      const writer = commandProcess.stdin.getWriter()
      await writer.write(io.stdin)
      await writer.close()
    }
    const abort = () => {
      void sandbox?.terminate().catch(() => undefined)
    }
    signal?.addEventListener("abort", abort, { once: true })
    let exitCode: number
    try {
      ;[, , exitCode] = await Promise.all([
        drain(commandProcess.stdout, (chunk) => output.add("stdout", chunk)),
        drain(commandProcess.stderr, (chunk) => output.add("stderr", chunk)),
        commandProcess.wait(),
      ])
      // terminate({wait:true}) below waits for the final volume commit before
      // this command returns and releases its drive locks (including v1 volumes).
    } finally {
      signal?.removeEventListener("abort", abort)
    }
    return output.result(exitCode)
  } finally {
    try {
      if (!allocationRequested) {
        stopped()
        if (operation)
          await executionCredits.settle(operation, 0, null, {
            allocationStarted: false,
          })
      }
      if (sandbox) {
        await sandbox.terminate({ wait: true })
        stopped()
        if (operation)
          await executionCredits.settle(
            operation,
            Math.ceil(((performance.now() - allocatedAt) / 1000) * RATE),
            sandbox.sandboxId,
            {
              allocatedMs: performance.now() - allocatedAt,
              cpu: 1,
              memoryMiB: 512,
              providerInvoiceCost: null,
            }
          )
      }
      // An allocation with an unknown outcome remains reserved for reconciliation.
    } finally {
      sandbox?.detach()
      await client?.close()
    }
  }
}

/** Each command gets a fresh isolated sandbox; only mounted drives survive it. */
export async function runAgentSandboxCommand(
  context: BuildContext,
  configuration: AgentSandboxConfiguration,
  input: unknown,
  signal?: AbortSignal,
  io: CommandIO = {}
): Promise<SandboxCommandResult> {
  if (io.stdin && Buffer.byteLength(io.stdin) > 512 * 1024)
    throw new Error("File input is too large.")
  const config = agentSandboxSchema.parse(configuration)
  const { command, timeoutSeconds } = sandboxCommandSchema.parse(input)
  if (!config.enabled) throw new Error("Sandbox is disabled for this agent.")
  await assertBuildProject(context)
  await getSandboxProviderCredentials(
    context.projectId,
    config.provider,
    context.database
  )
  const leaseToken = randomUUID()
  // Commit leases before starting external work. If a worker disappears or a
  // provider outcome is unknown, leases outlive the sandbox's 120-second limit.
  const mounts = await context.database.transaction(async (tx) => {
    const scoped = {
      ...context,
      database: tx as unknown as BuildContext["database"],
    }
    const mounts = await resolveSandboxDrives(scoped, config)
    for (const mount of [...mounts].sort((a, b) => a.id.localeCompare(b.id))) {
      const lock = await tx.execute(sql`
        UPDATE build_drives SET lease_token = ${leaseToken}, lease_until = now() + interval '5 minutes'
        WHERE project_id = ${context.projectId} AND id = ${mount.id}::uuid
          AND (lease_until IS NULL OR lease_until <= now()) RETURNING id
      `)
      if (!lock.rows.length)
        throw new SandboxDriveBusyError(
          "A mounted drive is busy. Try again after the other sandbox finishes."
        )
    }
    return mounts
  })
  let stopped = false
  try {
    signal?.throwIfAborted()
    if (config.provider === "local")
      return await localCommand(
        context,
        config,
        mounts,
        command,
        timeoutSeconds,
        () => {
          stopped = true
        },
        signal,
        io
      )
    return await modalCommand(
      context,
      config,
      mounts,
      command,
      timeoutSeconds,
      () => {
        stopped = true
      },
      signal,
      io
    )
  } finally {
    if (stopped && mounts.length)
      await context.database.execute(sql`
      UPDATE build_drives SET lease_token = NULL, lease_until = NULL
      WHERE project_id = ${context.projectId} AND lease_token = ${leaseToken}::uuid
    `)
  }
}
