import { createServer, type IncomingMessage } from "node:http"
export async function serveWebhook(
  handler: (request: Request) => Promise<Response>
) {
  const server = createServer(async (incoming: IncomingMessage, outgoing) => {
    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of incoming) {
        size += chunk.length
        if (size > 1024 * 1024) {
          outgoing.writeHead(413).end()
          return
        }
        chunks.push(chunk)
      }
      const response = await handler(
        new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers: incoming.headers as Record<string, string>,
          ...(!["GET", "HEAD"].includes(incoming.method ?? "GET")
            ? { body: Buffer.concat(chunks) }
            : {}),
        })
      )
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500).end("Webhook failed")
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  return {
    port: (server.address() as import("node:net").AddressInfo).port,
    stop() {
      server.closeAllConnections()
      server.close()
    },
  }
}
