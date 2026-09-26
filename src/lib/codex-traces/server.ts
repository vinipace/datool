import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { Readable } from "node:stream"

export async function serveCodexCollector(
  handler: (request: Request) => Promise<Response>,
  port = 0
) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const headers = new Headers()
      for (const [name, values] of Object.entries(incoming.headers)) {
        if (Array.isArray(values))
          values.forEach((value) => headers.append(name, value))
        else if (values !== undefined) headers.set(name, values)
      }
      const response = await handler(
        new Request(`http://127.0.0.1${incoming.url}`, {
          method: incoming.method,
          headers,
          ...(incoming.method === "POST"
            ? {
                body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
                duplex: "half",
              }
            : {}),
        } as RequestInit)
      )
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      outgoing.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      outgoing.writeHead(500).end("Collector request failed")
    }
  })
  server.requestTimeout = 30_000
  server.headersTimeout = 10_000
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", resolve)
  })
  return {
    port: (server.address() as AddressInfo).port,
    stop(force = false) {
      return new Promise<void>((resolve, reject) => {
        if (force) server.closeAllConnections()
        server.close((error) =>
          error &&
          (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING"
            ? reject(error)
            : resolve()
        )
      })
    },
  }
}
