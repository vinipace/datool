import { sandboxRpc, sandboxStream } from "./sandbox-rpc"
import { boatDocker, stopBoatSandbox } from "./boat"
import type { BoatDocker } from "../sandbox/boat"
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
import { cloudStorage } from "@/src/lib/build/storage"
import {
  hydrateCloudDrives,
  checkpointCloudDrives,
  recoverCloudDrives,
} from "./storage/sync"
import { assertDriveLease, loadCloudDrive } from "./storage/files"
import { maxArchiveBytes } from "./storage/archive"

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

type CommandIO = {
  stdin?: string
  maxOutputBytes?: number
  docker?: BoatDocker
  rpc?: (request: unknown) => Promise<unknown>
}

function collector(limit = 32 * 1024) {
  let remaining = Math.min(limit, Math.ceil((maxArchiveBytes * 4) / 3) + 4096)
  let truncated = false
  const parts: Record<"stdout" | "stderr", Buffer[]> = {
    stdout: [],
    stderr: [],
  }
  return {
    add(stream: "stdout" | "stderr", chunk: string | Uint8Array) {
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
  const execute = (
    binary: string,
    args: string[],
    options: { timeout?: number; signal?: AbortSignal }
  ) =>
    io.docker
      ? io.docker.exec(args, options)
      : executeFile(binary, args, options)
  if (io.docker) await io.docker.prepare(images[config.environment])
  const projectId = context.projectId
  const image = images[config.environment]
  const names = mounts.map((mount) => ({
    ...mount,
    volume: volumeName(projectId, mount.id),
  }))
  for (const mount of names) {
    if (mount.provisioned) {
      // A missing drive is an error, never a new empty directory after host loss.
      await execute(docker, ["volume", "inspect", mount.volume], {
        timeout: 10_000,
        signal,
      })
    } else {
      await execute(
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
    await execute(
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
    const args = [
      "run",
      ...(io.stdin !== undefined || io.rpc ? ["-i"] : []),
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
    ]
    if (io.docker) {
      const child = io.docker.spawn(
        args,
        io.stdin !== undefined || Boolean(io.rpc),
        Boolean(io.rpc)
      )
      const abort = () => {
        void Promise.resolve(child.kill()).catch(() => undefined)
      }
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) abort()
      try {
        const writer = child.stdin?.getWriter()
        const writing = (async () => {
          if (io.stdin !== undefined) await writer!.write(Buffer.from(io.stdin))
          if (!io.rpc) await writer?.close()
        })()
        const stdout = sandboxStream(child.stdout)
        const stderr = sandboxStream(child.stderr)
        const [result] = await Promise.all([
          child.wait(),
          io.rpc
            ? sandboxRpc(
                stdout,
                (text) => writer!.write(Buffer.from(text)),
                io.rpc,
                (text) => output.add("stdout", text)
              )
            : (async () => {
                for await (const chunk of stdout) output.add("stdout", chunk)
              })(),
          (async () => {
            for await (const chunk of stderr) output.add("stderr", chunk)
          })(),
          writing,
        ])
        return output.result(result.exitCode)
      } finally {
        signal?.removeEventListener("abort", abort)
      }
    }
    const child = spawn(/* turbopackIgnore: true */ docker, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    })
    child.stdin.on("error", () => undefined)
    if (io.rpc) child.stdin.write(io.stdin ?? "")
    else child.stdin.end(io.stdin)
    const timer = setTimeout(() => child.kill("SIGKILL"), (timeout + 20) * 1000)
    try {
      const closed = new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => resolve(code ?? 137))
      })
      const [code] = await Promise.all([
        closed,
        io.rpc
          ? sandboxRpc(
              child.stdout,
              (text) =>
                new Promise<void>((resolve, reject) =>
                  child.stdin.write(text, (error) =>
                    error ? reject(error) : resolve()
                  )
                ),
              io.rpc,
              (text) => output.add("stdout", text)
            )
          : (async () => {
              for await (const chunk of child.stdout)
                output.add("stdout", chunk)
            })(),
        (async () => {
          for await (const chunk of child.stderr) output.add("stderr", chunk)
        })(),
      ])
      return output.result(code)
    } finally {
      clearTimeout(timer)
      child.kill("SIGKILL")
    }
  } finally {
    // Removing the client process does not remove a running container.
    if (io.docker) await io.docker.remove(name)
    else await stopLocalContainer(docker, name)
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
    const writer = commandProcess.stdin.getWriter()
    if (io.stdin !== undefined) await writer.write(io.stdin)
    if (!io.rpc) await writer?.close()
    const abort = () => {
      void sandbox?.terminate().catch(() => undefined)
    }
    signal?.addEventListener("abort", abort, { once: true })
    let exitCode: number
    try {
      ;[, , exitCode] = await Promise.all([
        io.rpc
          ? sandboxRpc(
              sandboxStream(commandProcess.stdout),
              (text) => writer.write(text),
              io.rpc,
              (text) => output.add("stdout", text)
            )
          : drain(commandProcess.stdout, (chunk) =>
              output.add("stdout", chunk)
            ),
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
  if (
    io.stdin &&
    Buffer.byteLength(io.stdin) > (io.rpc ? 4 * 1024 * 1024 : 512 * 1024)
  )
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
  await recoverCloudDrives(context, config)
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
          AND NOT sync_pending AND (lease_until IS NULL OR lease_until <= now()) RETURNING id
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
    await hydrateCloudDrives(context, config, mounts, leaseToken)
    const nativeMounts = mounts.map((mount) => ({
      ...mount,
      provisioned: cloudStorage(mount.provider) ? true : mount.provisioned,
    }))
    const nativeDocker =
      config.provider === "boat"
        ? await boatDocker(context, leaseToken, true)
        : undefined
    const result =
      config.provider === "local" || config.provider === "boat"
        ? await localCommand(
            context,
            config,
            nativeMounts,
            command,
            timeoutSeconds,
            () => {
              stopped = true
            },
            signal,
            { ...io, docker: nativeDocker }
          )
        : await modalCommand(
            context,
            config,
            nativeMounts,
            command,
            timeoutSeconds,
            () => {
              stopped = true
            },
            signal,
            io
          )
    await checkpointCloudDrives(context, config, mounts, leaseToken)
    return result
  } finally {
    if (config.provider === "boat") await stopBoatSandbox(context, leaseToken)
    if (stopped && mounts.length)
      await context.database.execute(sql`
      UPDATE build_drives SET lease_token = NULL, lease_until = NULL
      WHERE project_id = ${context.projectId} AND lease_token = ${leaseToken}::uuid AND NOT sync_pending
    `)
  }
}

/** Server-owned transfer: credentials stay outside the sandbox and callers must own its drive lease. */
export async function transferDriveArchive(
  context: BuildContext,
  config: AgentSandboxConfiguration,
  driveId: string,
  token: string,
  archive?: Buffer
) {
  await assertDriveLease(context, driveId, token)
  await getSandboxProviderCredentials(
    context.projectId,
    config.provider,
    context.database
  )
  const command = archive
    ? "chmod -R u+rwX /workspace && find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && base64 -d | tar --no-same-owner -xf - -C /workspace"
    : "set -o pipefail; tar -cf - -C /workspace . | base64 -w0"
  const configuration = {
    ...config,
    enabled: true,
    environment: "node" as const,
    networkAccess: false,
    workingDirectory: "/workspace",
    drives: [{ driveId, mountPath: "/workspace" }],
  }
  const drive =
    config.provider === "boat" ? await loadCloudDrive(context, driveId) : null
  if (drive && !drive.sync_compute_id)
    throw new Error("Boat drive cache receipt is missing.")
  const nativeDocker = drive
    ? await boatDocker(context, drive.sync_compute_id!)
    : undefined
  const run =
    config.provider === "local" || config.provider === "boat"
      ? localCommand
      : modalCommand
  const result = await run(
    context,
    configuration,
    [
      {
        id: driveId,
        mountPath: "/workspace",
        provisioned: archive === undefined,
      },
    ],
    `bash -c '${command.replaceAll("'", "'\\''")}'`,
    60,
    () => {},
    undefined,
    {
      ...(archive ? { stdin: archive.toString("base64") } : {}),
      maxOutputBytes: Math.ceil((maxArchiveBytes * 4) / 3) + 4096,
      docker: nativeDocker,
    }
  )
  if (result.exitCode !== 0 || result.truncated)
    throw new Error(
      "Drive transfer failed or exceeded the archive limit. Its previous committed version remains available."
    )
  await assertDriveLease(context, driveId, token)
  return Buffer.from(result.stdout, "base64")
}
