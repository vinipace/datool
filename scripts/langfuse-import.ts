import { parseArgs } from "node:util"
import { sql } from "drizzle-orm"
import { db as sharedDb, analyticsDb } from "../lib/db"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { redisConnection } from "../src/server/ingestion/queue"
import { backfillAnalytics } from "../src/server/imports/langfuse/backfill"
import {
  credentialsFromEnvironment,
  LangfuseClient,
  SourceError,
} from "../src/server/imports/langfuse/client"
import {
  createRun,
  readRun,
  report,
} from "../src/server/imports/langfuse/store"
import {
  createImportQueue,
  enqueueImport,
  startImportWorker,
} from "../src/server/imports/langfuse/worker"

function requireLocal(value: string | undefined, label: string) {
  if (
    !value ||
    !["localhost", "127.0.0.1", "[::1]"].includes(new URL(value).hostname)
  )
    throw new SourceError(`${label}_MUST_BE_LOCAL`)
}
async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      project: { type: "string" },
      run: { type: "string" },
      from: { type: "string" },
      to: { type: "string" },
      all: { type: "boolean" },
      "page-size": { type: "string" },
      kind: { type: "string" },
      "source-id": { type: "string" },
      after: { type: "string" },
      "dry-run": { type: "boolean" },
    },
  })
  const command = positionals[0]
  if (!command || command === "help") {
    console.info(
      "Langfuse import: start --project ID (--from ISO | --all) [--to ISO] [--page-size 50]; worker; backfill --project ID [--dry-run]; status|resume --project ID --run ID; issues --project ID --run ID --kind KIND [--after ID]; record --project ID --run ID --kind KIND --source-id ID"
    )
    return
  }
  requireLocal(process.env.DATABASE_URL, "DATABASE_URL")
  if (command === "worker") {
    requireLocal(process.env.REDIS_URL, "REDIS_URL")
    credentialsFromEnvironment()
    const connection = redisConnection(true),
      abort = new AbortController()
    const worker = startImportWorker({ connection, signal: abort.signal })
    worker.on("error", () => console.error("Import worker connection error"))
    worker.on("failed", (job) =>
      console.error(
        JSON.stringify({
          event: "import_failed",
          runId: job?.data.runId,
          attempts: job?.attemptsMade,
        })
      )
    )
    worker.on("completed", (job) =>
      console.info(
        JSON.stringify({ event: "import_finished", runId: job.data.runId })
      )
    )
    console.info("Langfuse import worker started")
    await new Promise<void>((resolve) => {
      const stop = () => {
        abort.abort()
        resolve()
      }
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
    })
    await worker.close()
    await connection.quit()
    return
  }
  if (!values.project) throw new SourceError("DESTINATION_PROJECT_REQUIRED")
  const database = createTracerDatabase(undefined, {
    projectId: values.project,
  })
  try {
    if (command === "backfill") {
      console.info(
        JSON.stringify(
          await backfillAnalytics(database, { dryRun: values["dry-run"] }),
          null,
          2
        )
      )
      return
    }
    if (command === "status") {
      if (!values.run) throw new SourceError("RUN_ID_REQUIRED")
      console.info(JSON.stringify(await report(database, values.run), null, 2))
      return
    }
    if (command === "issues") {
      if (!values.run || !values.kind)
        throw new SourceError("RUN_AND_KIND_REQUIRED")
      await readRun(database, values.run)
      const rows = (
        await database.execute(
          sql`select source_id as "sourceId",status,reason,destination_id as "destinationId" from langfuse_import_records where project_id=${values.project} and run_id=${values.run} and kind=${values.kind} and status not in ('pending','imported') ${values.after ? sql`and source_id > ${values.after}` : sql``} order by source_id limit 51`
        )
      ).rows
      console.info(
        JSON.stringify(
          {
            items: rows.slice(0, 50),
            nextCursor: rows.length > 50 ? rows[49].sourceId : null,
          },
          null,
          2
        )
      )
      return
    }
    if (command === "record") {
      if (!values.run || !values.kind || !values["source-id"])
        throw new SourceError("RECORD_ID_REQUIRED")
      await readRun(database, values.run)
      const result = await database.execute(
        sql`select * from langfuse_import_records where project_id=${values.project} and run_id=${values.run} and kind=${values.kind} and source_id=${values["source-id"]}`
      )
      console.info(JSON.stringify(result.rows, null, 2))
      return
    }
    if (!["start", "resume"].includes(command))
      throw new SourceError("UNKNOWN_IMPORT_COMMAND")
    requireLocal(process.env.REDIS_URL, "REDIS_URL")
    let runId = values.run
    if (command === "start") {
      if ((!values.from && !values.all) || (values.from && values.all))
        throw new SourceError("CHOOSE_FROM_OR_ALL")
      const credentials = credentialsFromEnvironment(),
        client = new LangfuseClient(credentials)
      const sourceProjectId = await client.project()
      const run = await createRun(database, {
        host: client.host,
        sourceProjectId,
        from: values.from ?? "1970-01-01T00:00:00.000Z",
        to: values.to ?? new Date(Date.now() - 15 * 60 * 1000).toISOString(),
        pageSize: values["page-size"] ? Number(values["page-size"]) : 50,
      })
      runId = run.id
      // Print the durable ID before dispatch; a Redis outage can be recovered with resume.
      console.info(
        JSON.stringify({
          runId,
          projectId: values.project,
          from: run.from_time,
          to: run.to_time,
        })
      )
    } else {
      if (!runId) throw new SourceError("RUN_ID_REQUIRED")
      await readRun(database, runId)
    }
    const connection = redisConnection(),
      queue = createImportQueue(connection)
    try {
      await enqueueImport(queue, { projectId: values.project, runId: runId! })
      console.info(JSON.stringify({ queued: true, runId }))
    } finally {
      await queue.close()
      await connection.quit()
    }
  } finally {
    await closeTracerDatabase(database)
  }
}
main()
  .catch((error) => {
    console.error(
      error instanceof SourceError
        ? error.code
        : "IMPORT_COMMAND_FAILED: check local configuration, migrations and arguments"
    )
    process.exitCode = 1
  })
  .finally(async () => {
    await sharedDb.end()
    if (analyticsDb !== sharedDb) await analyticsDb.end()
  })
