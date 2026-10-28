import { redisConnection } from "@/src/server/ingestion/queue"
import { once } from "node:events"

let connection: ReturnType<typeof redisConnection> | undefined
let ready: Promise<ReturnType<typeof redisConnection>> | undefined
export async function diagnosticRedis() {
  if (!connection) {
    connection = redisConnection()
    // The request's command rejects on failure; the collector returns 503 so
    // the phone retains the report. Do not emit credential-bearing driver errors.
    connection.on("error", () => {})
  }
  if (connection.status === "ready") return connection
  const client = connection
  // The shared Redis helper disables its offline command queue. Wait for the
  // initial connection (or reconnection) before issuing the admission script.
  ready ??= once(client, "ready", { signal: AbortSignal.timeout(5000) }).then(() => client).finally(() => { ready = undefined })
  return ready
}
