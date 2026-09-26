import { execFileSync, spawn, type ChildProcess } from "node:child_process"
import { access, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Pool } from "pg"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
} from "../tests/helpers/postgres"
import {
  permissionStatements,
  workspaceScopes,
} from "../src/lib/auth/permissions"

const consumerPath = process.argv[2]
if (!consumerPath) {
  throw new Error(
    "Usage: bun run test:packages:integration /path/to/consumer-app"
  )
}
const consumer = resolve(consumerPath)
await access(join(consumer, "tests/datool-packages.mjs"))
process.chdir(fileURLToPath(new URL("..", import.meta.url)))
const id = crypto.randomUUID().slice(0, 8)
const owned: string[] = []
const directory = await mkdtemp(join(tmpdir(), "datool-package-integration-"))
let target: Awaited<ReturnType<typeof createIsolatedPostgres>> | undefined
let server: ChildProcess | undefined
let authPools: typeof import("../lib/db") | undefined
let inspection: Pool | undefined
const docker = (args: string[]) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim()
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return
  child.kill("SIGTERM")
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    pause(10_000),
  ])
  if (child.exitCode === null) child.kill("SIGKILL")
}
try {
  const pgName = `datool-package-pg-${id}`
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    pgName,
    "-e",
    "POSTGRES_PASSWORD=package-fixture",
    "-p",
    "127.0.0.1::5432",
    "postgres:18-alpine",
  ])
  owned.push(pgName)
  const redisName = `datool-package-redis-${id}`
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    redisName,
    "-p",
    "127.0.0.1::6379",
    "redis:7-alpine",
  ])
  owned.push(redisName)
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      docker(["exec", pgName, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"])
      ready = true
      break
    } catch {
      await pause(500)
    }
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready")
  const port = (name: string, internal: string) =>
    docker(["port", name, internal]).split(":").at(-1)
  delete process.env.DATABASE_URL
  process.env.DATOOL_TEST_DATABASE_URL = `postgresql://postgres:package-fixture@127.0.0.1:${port(pgName, "5432/tcp")}/postgres`
  execFileSync(
    process.execPath,
    [
      "test",
      "tests/tracer-sdk.test.ts",
      "tests/tracer-instrumentation.test.ts",
      "tests/tracer-otel.test.ts",
      "tests/call-context.test.ts",
      "tests/app-connections.test.ts",
    ],
    {
      env: {
        ...process.env,
        DATABASE_URL: "",
        DATOOL_PROJECT_ID: "package-fixture-project",
        DATOOL_API_KEY: "package-fixture-key",
      },
      stdio: "inherit",
    }
  )
  target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  Object.assign(process.env, {
    DATABASE_URL: target.databaseUrl,
    REDIS_URL: `redis://127.0.0.1:${port(redisName, "6379/tcp")}`,
    BETTER_AUTH_URL: "http://127.0.0.1:3000",
    BETTER_AUTH_SECRET: `disposable-package-fixture-${id}-secret`,
    DATOOL_DATA_DIR: directory,
    DATOOL_PACKAGE_TEST: "1",
  })
  authPools = await import("../lib/db")
  const { getAuth } = await import("../lib/auth")
  const credential = await getAuth().api.createApiKey({
    body: {
      organizationId: target.organizationId,
      userId: target.ownerId,
      name: "Disposable package acceptance",
      permissions: permissionStatements(workspaceScopes),
      rateLimitMax: 10000,
      rateLimitTimeWindow: 60000,
    },
  })
  server = spawn(process.execPath, ["run", "scripts/packages/test-server.ts"], {
    env: {
      ...process.env,
      DATOOL_PROJECT_ID: target.projectId,
      DATOOL_API_KEY: credential.key,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let output = ""
    const timeout = setTimeout(
      () => reject(new Error("Package API test host timed out")),
      30_000
    )
    server!.stdout!.on("data", (data) => {
      output += String(data)
      const match = output.match(/PACKAGE_SERVER=(http:\/\/127\.0\.0\.1:\d+)/)
      if (match) {
        clearTimeout(timeout)
        resolve(match[1])
      }
    })
    server!.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Package API test host exited (${code})`))
    })
    server!.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
  console.info("Disposable authenticated API and Redis worker ready.")
  const env = {
    ...process.env,
    DATOOL_BASE_URL: baseUrl,
    DATOOL_URL: baseUrl,
    DATOOL_API_KEY: credential.key,
    DATOOL_PROJECT_ID: target.projectId,
    OPENAI_API_KEY: "fixture-never-sent",
    DATOOL_DELIVERY: "queued",
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn("node", ["tests/datool-packages.mjs"], {
      cwd: consumer,
      env,
      stdio: "inherit",
    })
    const timer = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error("Consumer package acceptance exceeded 120 seconds"))
    }, 120_000)
    child.once("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.once("exit", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`Consumer acceptance failed (${code})`))
    })
  })
  inspection = new Pool({ connectionString: target.databaseUrl })
  const receipts = await inspection.query(
    "select count(*)::int as count from ingestion_receipts where project_id=$1",
    [target.projectId]
  )
  const traceCount = await inspection.query(
    "select count(*)::int as count from traces where project_id=$1",
    [target.projectId]
  )
  if (receipts.rows[0].count < 10 || traceCount.rows[0].count < 4)
    throw new Error("Expected durable lifecycle receipts and traces")
  console.info(
    `PASS: Consumer tarball integration persisted ${traceCount.rows[0].count} traces and ${receipts.rows[0].count} lifecycle receipts in PostgreSQL.`
  )
} finally {
  if (server) await stop(server)
  await inspection?.end()
  if (authPools)
    await Promise.all([authPools.db.end(), authPools.analyticsDb.end()])
  await target?.close()
  for (const container of owned.reverse()) {
    try {
      docker(["rm", "-f", container])
    } catch {
      /* Only owned disposable services. */
    }
  }
  await rm(directory, { recursive: true, force: true })
}
