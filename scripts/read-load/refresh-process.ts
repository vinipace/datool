/** Child app process used only by the loopback cache-resilience harness. */
import { localEndpoint } from "./safety"
import { serveWebhook } from "../../src/server/apps/webhook"
localEndpoint(process.env.DATABASE_URL ?? "", ["postgres:", "postgresql:"])
localEndpoint(process.env.REDIS_URL ?? "", ["redis:"])
if (!new URL(process.env.DATABASE_URL!).searchParams.get("options")?.includes("datool_test_")) throw new Error("Isolated test schema required")
if (!process.send) throw new Error("Test IPC parent required")
const { db, analyticsDb } = await import("../../lib/db")
const { routeCacheRedis } = await import("../../src/server/cache/redis")
const { sharedReadCache } = await import("../../src/server/tracer/shared-read-cache")
const { refreshRoutes } = await import("./refresh-routes")
const route = await refreshRoutes()
const server = await serveWebhook(route)
const redis = routeCacheRedis()!
if (redis.status !== "ready") await new Promise<void>((resolve, reject) => { redis.once("ready", resolve); redis.once("error", reject) })
process.send({ ready: true, port: server.port, pid: process.pid })
process.on("message", async (message: { id: number; action: string; mode?: string; key?: string; delayMs?: number; projectId?: string }) => {
  try {
    let result: unknown
    if (message.action === "mode") {
      process.env.DATOOL_TRACE_READ_CACHE = message.mode === "off" ? "off" : "combined"
      process.env.DATOOL_COLLECTION_READ_CACHE = message.mode === "off" ? "off" : "shared"
      result = true
    } else if (message.action === "status") result = { redis: redis.status, pid: process.pid }
    else if (message.action === "budget") {
      result = await sharedReadCache()({ projectId: message.projectId!, key: message.key!,
        load: async () => ({ text: "x".repeat(2048) }) })
    } else if (message.action === "slow") {
      result = await sharedReadCache()({ projectId: message.projectId!, key: message.key!, load: async () => {
        const data = (await db.query("SELECT name FROM traces WHERE project_id=$1 AND id='trace-1'", [message.projectId])).rows[0]
        process.send!({ entered: message.id })
        await new Promise(resolve => setTimeout(resolve, message.delayMs ?? 0))
        return data
      } })
    } else if (message.action === "close") {
      server.stop(); await redis.quit(); await db.end(); await analyticsDb.end()
      process.send!({ id: message.id, result: true }); process.disconnect(); return
    } else throw new Error("Unknown test command")
    process.send!({ id: message.id, result })
  } catch (error) { process.send!({ id: message.id, error: String(error) }) }
})
