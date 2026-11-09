// Run the production Eve build under Node 24. Datool owns channel scheduling.
if (!process.env.DATOOL_EVE_SECRET && process.env.DATOOL_BUILD_ENABLED !== "true" && !process.env.DATOOL_BUILD_ORGANIZATION_IDS) {
  console.info("[eve] Build agents disabled; configure DATOOL_EVE_SECRET before enabling them.")
  await new Promise(resolve => {
    const timer = setInterval(() => {}, 60_000)
    const stop = () => { clearInterval(timer); resolve() }
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
  })
  process.exit(0)
}
if ((process.env.DATOOL_EVE_SECRET?.length ?? 0) < 32) throw new Error("DATOOL_EVE_SECRET must contain at least 32 characters.")
if (!process.env.DATABASE_URL || !process.env.WORKFLOW_POSTGRES_URL) throw new Error("DATABASE_URL and WORKFLOW_POSTGRES_URL are required.")
// All replicas must use renewable leases; the upstream default disables them.
process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS ??= "30"
process.env.WORKFLOW_POSTGRES_JOB_PREFIX ||= "datool_"
if (!Number.isInteger(Number(process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS)) || Number(process.env.WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS) <= 0) throw new Error("WORKFLOW_POSTGRES_JOB_LOCK_STALE_SECONDS must be a positive integer.")
process.env.WORKFLOW_POSTGRES_WORKER_CONCURRENCY ??= "4"
process.env.WORKFLOW_POSTGRES_MAX_POOL_SIZE ??= "8"
process.env.EVE_SCHEDULES_DISABLED = "1"
process.env.HOST = process.env.NITRO_HOST = "0.0.0.0"
process.env.PORT = process.env.NITRO_PORT = process.env.DATOOL_EVE_PORT ?? "2001"
await import(new URL("../.output/server/index.mjs", import.meta.url).href)
