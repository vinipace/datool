import { boatDocker, stopBoatSandbox } from "../boat"
import type { BoatDocker } from "../../sandbox/boat"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { Readable, Writable } from "node:stream"
import { promisify } from "node:util"
import { sql } from "drizzle-orm"
import type { ModalClient, Sandbox } from "modal"
import type { SandboxConnection } from "eve/sandbox/provider"
import type { SandboxProcess } from "eve/sandbox"
import type { BuildContext } from "../context"
import type { EveExecution } from "./contracts"
import { assertEveOwnership, getEveExecution } from "./store"
import { resolveSandboxDrives } from "../drives"
import {
  hydrateCloudDrives,
  checkpointCloudDrives,
  recoverCloudDrives,
} from "../storage/sync"
import {
  images,
  markProvisioned,
  volumeName,
  RATE,
  RATE_VERSION,
} from "../sandbox-runtime"
import { getSandboxProviderCredentials } from "../../sandbox/providers-store"
import { assertManagedProject } from "../../execution-credits/config"
import { executionCredits } from "../../execution-credits/ledger"

const exec = promisify(execFile)
const lifetimeSeconds = 600
const appName = "datool-agents"
// Keep Eve's runtime imports at the authored provider boundary. Tracing Eve
// through the external bridge also pulls its compiler into the server bundle.
export class DatoolSandboxGoneError extends Error {}
const docker = () =>
  process.env.DATOOL_SANDBOX_DOCKER_BINARY?.trim() || "docker"
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
type Row = {
  id: string
  project_id: string
  turn_id: string
  session_id: string
  provider: "local" | "modal" | "datool" | "boat"
  native_name: string
  native_id: string | null
  operation_id: string | null
  status: "creating" | "running" | "closing" | "closed"
  created_at: Date
  expires_at: Date
  closed_at: Date | null
}
export type DatoolSandboxState = {
  id: string
  projectId: string
  turnId: string
}

async function rowFor(context: BuildContext, turnId: string) {
  return (
    await context.database.execute<Row>(
      sql`SELECT * FROM build_agent_sandboxes WHERE project_id=${context.projectId} AND turn_id=${turnId}`
    )
  ).rows[0]
}
async function modalClient(context: BuildContext, provider: Row["provider"]) {
  const { ModalClient } = await import("modal")
  const credentials = await getSandboxProviderCredentials(
    context.projectId,
    provider,
    context.database
  )
  if (provider === "datool") {
    return new ModalClient({
      tokenId: process.env.DATOOL_MODAL_TOKEN_ID,
      tokenSecret: process.env.DATOOL_MODAL_TOKEN_SECRET,
      timeoutMs: 15_000,
      maxRetries: 0,
    })
  }
  if (credentials.provider !== "modal")
    throw new Error("Configure Modal in project Sandbox providers first.")
  return new ModalClient({
    tokenId: credentials.tokenId,
    tokenSecret: credentials.tokenSecret,
    timeoutMs: 15_000,
    maxRetries: 0,
  })
}
function missing(error: unknown) {
  return /not found|notfound|no such (container|sandbox)/i.test(
    String(error) + String((error as { stderr?: string })?.stderr ?? "")
  )
}

/** Admission commits the drive lease before any provider allocation. */
export async function openDatoolSandbox(
  context: BuildContext,
  run: EveExecution,
  sessionId: string,
  state?: DatoolSandboxState
) {
  await assertEveOwnership(context, run)
  if (
    !run.plan.sandboxEnabled ||
    run.plan.scopeRestricted ||
    run.plan.simulation
  )
    throw new Error("The environment is unavailable for this execution.")
  if (
    state &&
    (state.projectId !== context.projectId || state.turnId !== run.turnId)
  )
    throw new Error("Invalid environment identity.")
  const config = run.plan.configuration.sandbox
  await getSandboxProviderCredentials(
    context.projectId,
    config.provider,
    context.database
  )
  let row = await rowFor(context, run.turnId)
  let created = false
  if (!row && !state) {
    await recoverCloudDrives(context, config)
    const id = randomUUID()
    const result = await context.database.transaction(async (tx) => {
      const result =
        await tx.execute<Row>(sql`INSERT INTO build_agent_sandboxes(id,project_id,turn_id,session_id,provider,native_name,expires_at)
        VALUES(${id}::uuid,${context.projectId},${run.turnId},${sessionId},${config.provider},${`datool-agent-${id}`},now()+make_interval(secs=>${lifetimeSeconds}))
        ON CONFLICT(turn_id) DO NOTHING RETURNING *`)
      if (!result.rows.length) return undefined
      const mounts = await resolveSandboxDrives(
        { ...context, database: tx as unknown as BuildContext["database"] },
        config
      )
      for (const mount of [...mounts].sort((a, b) =>
        a.id.localeCompare(b.id)
      )) {
        const lease =
          await tx.execute(sql`UPDATE build_drives SET lease_token=${id}::uuid,lease_until=now()+make_interval(secs=>${lifetimeSeconds + 120})
          WHERE project_id=${context.projectId} AND id=${mount.id}::uuid AND NOT sync_pending AND (lease_until IS NULL OR lease_until<=now()) RETURNING id`)
        if (!lease.rows.length)
          throw new Error(
            "A mounted drive is busy. Try again after the other environment finishes."
          )
      }
      return result.rows[0]
    })
    created = Boolean(result)
    row = result ?? (await rowFor(context, run.turnId))
  }
  if (
    !row ||
    row.status === "closed" ||
    row.status === "closing" ||
    new Date(row.expires_at).getTime() <= Date.now()
  )
    throw new DatoolSandboxGoneError("The agent environment has ended.")
  if (row.session_id !== sessionId || (state && state.id !== row.id))
    throw new Error("Invalid environment session.")
  let client: ModalClient | undefined
  let sandbox: Sandbox | undefined
  let nativeDocker: BoatDocker | undefined
  const execute = (
    binary: string,
    args: string[],
    options?: { timeout?: number }
  ) =>
    nativeDocker
      ? nativeDocker.exec(args, options)
      : exec(binary, args, options ?? {})
  try {
    if (config.provider === "boat") {
      nativeDocker = await boatDocker(
        context,
        row.id,
        created || row.status === "creating"
      )
      row.native_id = nativeDocker.id
      await nativeDocker.prepare(images[config.environment])
    }
    const remainingLifetime = () => {
      const seconds = Math.floor(
        (new Date(row.expires_at).getTime() - Date.now()) / 1000
      )
      if (seconds < 1)
        throw new DatoolSandboxGoneError(
          "The agent environment expired during startup."
        )
      return seconds
    }
    if (created) {
      const mounts = await resolveSandboxDrives(context, config)
      await hydrateCloudDrives(context, config, mounts, row.id)
      if (config.provider === "local" || config.provider === "boat") {
        for (const mount of mounts) {
          const name = volumeName(context.projectId, mount.id)
          await execute(
            docker(),
            mount.provisioned
              ? ["volume", "inspect", name]
              : [
                  "volume",
                  "create",
                  "--label",
                  "datool.kind=agent-drive",
                  "--label",
                  `datool.project=${context.projectId}`,
                  "--label",
                  `datool.drive=${mount.id}`,
                  name,
                ]
          )
          await markProvisioned(context, mount.id)
          await execute(docker(), [
            "run",
            "--rm",
            "--pull=never",
            "--network=none",
            "--read-only",
            "--cap-drop=ALL",
            "--cap-add=CHOWN",
            "--security-opt=no-new-privileges",
            "--mount",
            `type=volume,src=${name},dst=/drive`,
            images[config.environment],
            "chown",
            "65534:65534",
            "/drive",
          ])
        }
        await execute(docker(), [
          "run",
          "-d",
          "--name",
          row.native_name,
          "--pull=never",
          "--init",
          "--label",
          `datool.project=${context.projectId}`,
          "--label",
          `datool.turn=${run.turnId}`,
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
          ...(mounts.some((mount) => mount.mountPath === "/workspace")
            ? []
            : ["--tmpfs=/workspace:rw,nosuid,size=128m,mode=1777"]),
          ...mounts.flatMap((mount) => [
            "--mount",
            `type=volume,src=${volumeName(context.projectId, mount.id)},dst=${mount.mountPath},volume-nocopy`,
          ]),
          "--env=HOME=/tmp",
          "--env=AI_AGENT=eve",
          images[config.environment],
          "bash",
          "-c",
          `mkdir -p ${quote(config.workingDirectory)} && exec sleep ${remainingLifetime()}`,
        ])
      } else {
        client = await modalClient(context, config.provider)
        if (config.provider === "datool") {
          await assertManagedProject(context.projectId, "sandbox")
          row.operation_id = await executionCredits.reserve(
            context.projectId,
            "sandbox",
            Math.ceil(lifetimeSeconds * RATE),
            RATE_VERSION
          )
          await context.database.execute(
            sql`UPDATE build_agent_sandboxes SET operation_id=${row.operation_id} WHERE id=${row.id}::uuid AND project_id=${context.projectId}`
          )
        }
        const app = await client.apps.fromName(appName, {
          createIfMissing: true,
        })
        const volumes: Record<
          string,
          Awaited<ReturnType<ModalClient["volumes"]["fromName"]>>
        > = {}
        for (const mount of mounts) {
          volumes[mount.mountPath] = await client.volumes.fromName(
            volumeName(context.projectId, mount.id),
            { createIfMissing: !mount.provisioned }
          )
          await markProvisioned(context, mount.id)
        }
        sandbox = await client.sandboxes.create(
          app,
          client.images.fromRegistry(images[config.environment]),
          {
            name: row.native_name,
            volumes,
            timeoutMs: remainingLifetime() * 1000,
            blockNetwork: !config.networkAccess,
            cpu: 1,
            cpuLimit: 1,
            memoryMiB: 512,
            memoryLimitMiB: 512,
            env: { HOME: "/tmp", AI_AGENT: "eve" },
            command: [
              "bash",
              "-c",
              `mkdir -p ${quote(config.workingDirectory)} && exec sleep ${remainingLifetime()}`,
            ],
          }
        )
        row.native_id = sandbox.sandboxId
        if (row.operation_id)
          await executionCredits.recordEvidence(
            row.operation_id,
            sandbox.sandboxId,
            { allocationStartedAt: new Date(row.created_at).toISOString() }
          )
      }
    } else if (config.provider === "local" || config.provider === "boat") {
      const result = await execute(docker(), [
        "inspect",
        "--format",
        "{{.State.Running}}",
        row.native_name,
      ])
      if (result.stdout.trim() !== "true")
        throw new DatoolSandboxGoneError("The agent environment stopped.")
    } else {
      client = await modalClient(context, config.provider)
      sandbox = row.native_id
        ? await client.sandboxes.fromId(row.native_id)
        : await client.sandboxes.fromName(appName, row.native_name)
      if ((await sandbox.poll()) !== null)
        throw new DatoolSandboxGoneError("The agent environment stopped.")
      row.native_id = sandbox.sandboxId
    }
    // A crash can leave the named provider allocation alive before its database
    // receipt is committed. Reconnection completes that receipt as well.
    await assertEveOwnership(
      context,
      await getEveExecution(context, run.turnId)
    )
    const activated = await context.database.execute(
      sql`UPDATE build_agent_sandboxes SET status='running',native_id=${row.native_id} WHERE id=${row.id}::uuid AND project_id=${context.projectId} AND status IN ('creating','running') AND expires_at>now() RETURNING id`
    )
    if (!activated.rows.length)
      throw new DatoolSandboxGoneError("The agent environment has ended.")
    const connection = connectionFor(
      context,
      run,
      row,
      client,
      sandbox,
      nativeDocker
    )
    return {
      connection,
      state: { id: row.id, projectId: context.projectId, turnId: run.turnId },
    }
  } catch (error) {
    sandbox?.detach()
    await client?.close()
    // A named allocation can be recovered or cleaned up without allocating twice.
    if (created)
      await closeDatoolSandbox(context, run.turnId).catch(() => undefined)
    if (missing(error))
      throw new DatoolSandboxGoneError(
        "The agent environment no longer exists."
      )
    throw error
  }
}

function connectionFor(
  context: BuildContext,
  run: EveExecution,
  row: Row,
  client?: ModalClient,
  sandbox?: Sandbox,
  nativeDocker?: BoatDocker
): SandboxConnection {
  async function assertActive() {
    await assertEveOwnership(
      context,
      await getEveExecution(context, run.turnId)
    )
    const current = await rowFor(context, run.turnId)
    if (
      !current ||
      current.status !== "running" ||
      new Date(current.expires_at).getTime() <= Date.now()
    )
      throw new DatoolSandboxGoneError("The agent environment has ended.")
  }
  async function raw(
    command: string,
    workingDirectory: string,
    env: Readonly<Record<string, string>>,
    stdin = false
  ): Promise<SandboxProcess> {
    const pidFile = `/tmp/.datool-process-${randomUUID()}`
    const script = `echo $$ > ${quote(pidFile)}; exec bash -lc ${quote(command)}`
    const argv = ["setsid", "--wait", "bash", "-c", script]
    const kill = async () => {
      const stop = `if test -f ${quote(pidFile)}; then kill -KILL -- -$(cat ${quote(pidFile)}) 2>/dev/null || true; fi`
      if (sandbox) {
        const process = await sandbox.exec(["bash", "-c", stop])
        await process.wait()
      } else if (nativeDocker)
        await nativeDocker.exec(["exec", row.native_name, "bash", "-c", stop])
      else await exec(docker(), ["exec", row.native_name, "bash", "-c", stop])
    }
    if (sandbox) {
      const process = await sandbox.exec(argv, {
        workdir: workingDirectory,
        env: { ...env },
        mode: "binary",
      })
      if (!stdin) await process.closeStdin()
      return {
        stdout: process.stdout,
        stderr: process.stderr,
        ...(stdin ? { stdin: process.stdin } : {}),
        wait: async () => ({ exitCode: await process.wait() }),
        kill,
      }
    }
    const args = [
      "exec",
      ...(stdin ? ["-i"] : []),
      "--workdir",
      workingDirectory,
      ...Object.entries(env).flatMap(([key, value]) => [
        "--env",
        `${key}=${value}`,
      ]),
      row.native_name,
      ...argv,
    ]
    if (nativeDocker) {
      const process = nativeDocker.spawn(args, stdin)
      return {
        ...process,
        kill: async () => {
          await kill()
          await process.kill()
        },
      }
    }
    const child = spawn(docker(), args, {
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    })
    const waited = new Promise<{ exitCode: number }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve({ exitCode: code ?? 137 }))
    })
    return {
      stdout: Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
      stderr: Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>,
      ...(stdin
        ? { stdin: Writable.toWeb(child.stdin!) as WritableStream<Uint8Array> }
        : {}),
      wait: () => waited,
      kill,
    }
  }
  const spawnCommand: SandboxConnection["spawn"] = async (options) => {
    options.signal?.throwIfAborted()
    await assertActive()
    const process = await raw(
      options.command,
      options.workingDirectory,
      options.env,
      options.stdin
    )
    const abort = () => {
      void Promise.resolve(process.kill()).catch(() => undefined)
    }
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) abort()
    const waited = Promise.resolve(process.wait()).finally(() =>
      options.signal?.removeEventListener("abort", abort)
    )
    return { ...process, wait: () => waited }
  }
  async function bytes(
    command: string,
    signal?: AbortSignal,
    input?: Uint8Array
  ) {
    const process = await spawnCommand({
      command,
      workingDirectory: run.plan.configuration.sandbox.workingDirectory,
      env: {},
      signal,
      stdin: input !== undefined,
    })
    const writing =
      input === undefined
        ? Promise.resolve()
        : (async () => {
            const writer = process.stdin!.getWriter()
            try {
              await writer.write(input)
              await writer.close()
            } finally {
              writer.releaseLock()
            }
          })()
    const [out, error, result] = await Promise.all([
      new Response(process.stdout).arrayBuffer(),
      new Response(process.stderr).text(),
      process.wait(),
      writing,
    ])
    if (result.exitCode !== 0 && result.exitCode !== 44)
      throw new Error(
        error.slice(0, 500) ||
          `Environment command exited with ${result.exitCode}.`
      )
    return result.exitCode === 44 ? null : new Uint8Array(out)
  }
  return {
    workspaceRoot: run.plan.configuration.sandbox.workingDirectory,
    spawn: spawnCommand,
    readFile: ({ path, signal }) =>
      bytes(
        `if ! test -e ${quote(path)}; then exit 44; fi; test -f ${quote(path)} || exit 1; test $(stat -c %s -- ${quote(path)}) -le 67108864 || { echo 'File exceeds 64 MiB' >&2; exit 1; }; cat -- ${quote(path)}`,
        signal
      ),
    async writeFiles({ files, signal }) {
      for (const file of files)
        await bytes(
          `mkdir -p -- "$(dirname -- ${quote(file.path)})" && cat > ${quote(file.path)}`,
          signal,
          file.content
        )
    },
    async removePath({ path, force, recursive, signal }) {
      await bytes(
        `rm ${force ? "-f" : ""} ${recursive ? "-r" : ""} -- ${quote(path)}`,
        signal
      )
    },
    // Explicit stop releases compute. Only mounted drives survive it.
    async stop() {
      await closeDatoolSandbox(context, run.turnId)
    },
    async close() {
      sandbox?.detach()
      await client?.close()
    },
  }
}

/** Idempotent cleanup also runs from the worker after a missed Eve hook. */
export async function closeDatoolSandbox(
  context: BuildContext,
  turnId: string
) {
  // The final hook, stream recovery and cleanup worker can race. Serialize
  // shutdown/checkpointing across processes and re-read the closed state.
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM build_agent_sandboxes WHERE project_id=${context.projectId} AND turn_id=${turnId} FOR UPDATE`
    )
    await closeLockedSandbox(
      { ...context, database: tx as unknown as BuildContext["database"] },
      turnId
    )
  })
}
async function closeLockedSandbox(context: BuildContext, turnId: string) {
  const row = await rowFor(context, turnId)
  if (!row || row.status === "closed") return
  await context.database.execute(
    sql`UPDATE build_agent_sandboxes SET status='closing' WHERE id=${row.id}::uuid AND project_id=${context.projectId} AND status<>'closed'`
  )
  if (row.provider === "boat") {
    try {
      const nativeDocker = await boatDocker(context, row.id)
      await nativeDocker.remove(row.native_name)
    } catch (error) {
      // A failed container-control request must still release VM compute. Keep
      // the original failure and the pending drive receipt for recovery.
      await stopBoatSandbox(context, row.id).catch(() => undefined)
      throw error
    }
  } else if (row.provider === "local") {
    try {
      await exec(docker(), ["rm", "--force", row.native_name], {
        timeout: 15_000,
      })
    } catch (error) {
      if (!missing(error)) throw error
    }
  } else {
    const client = await modalClient(context, row.provider)
    let sandbox: Sandbox | undefined
    try {
      try {
        sandbox = row.native_id
          ? await client.sandboxes.fromId(row.native_id)
          : await client.sandboxes.fromName(appName, row.native_name)
      } catch (error) {
        if (!missing(error)) throw error
      }
      if (
        !sandbox &&
        !row.native_id &&
        new Date(row.expires_at).getTime() > Date.now()
      )
        throw new Error(
          "Environment allocation outcome is uncertain; its drive leases remain held until expiry."
        )
      if (sandbox) await sandbox.terminate({ wait: true })
      if (row.operation_id) {
        const closed = await context.database.execute<{ closed_at: Date }>(
          sql`UPDATE build_agent_sandboxes SET closed_at=coalesce(closed_at,now()) WHERE id=${row.id}::uuid AND project_id=${context.projectId} RETURNING closed_at`
        )
        const seconds = Math.max(
          0,
          Math.min(
            lifetimeSeconds,
            (new Date(closed.rows[0].closed_at).getTime() -
              new Date(row.created_at).getTime()) /
              1000
          )
        )
        await executionCredits.settle(
          row.operation_id,
          Math.ceil(seconds * RATE),
          row.native_id,
          { allocatedSeconds: seconds, providerInvoiceCost: null }
        )
      }
    } finally {
      sandbox?.detach()
      await client.close()
    }
  }
  const run = await getEveExecution(context, turnId)
  const mounts = await resolveSandboxDrives(
    context,
    run.plan.configuration.sandbox
  )
  try {
    await checkpointCloudDrives(
      context,
      run.plan.configuration.sandbox,
      mounts,
      row.id
    )
  } finally {
    if (row.provider === "boat") await stopBoatSandbox(context, row.id)
  }
  await context.database.transaction(async (tx) => {
    await tx.execute(
      sql`UPDATE build_agent_sandboxes SET status='closed',closed_at=coalesce(closed_at,now()) WHERE id=${row.id}::uuid AND project_id=${context.projectId}`
    )
    await tx.execute(
      sql`UPDATE build_drives SET lease_token=NULL,lease_until=NULL WHERE project_id=${context.projectId} AND lease_token=${row.id}::uuid`
    )
  })
}

export async function cleanupDatoolSandboxes(context: BuildContext) {
  const rows = await context.database.execute<{
    turn_id: string
  }>(sql`SELECT s.turn_id FROM build_agent_sandboxes s JOIN build_eve_executions e ON e.turn_id=s.turn_id
    WHERE s.project_id=${context.projectId} AND s.status<>'closed' AND (s.expires_at<=now() OR e.status IN ('completed','failed','cancelled')) LIMIT 20`)
  for (const row of rows.rows) await closeDatoolSandbox(context, row.turn_id)
}
