import { createServer } from "node:https"
import { request } from "node:http"
import { readFileSync } from "node:fs"
createServer(
  {
    key: readFileSync("/test-fixtures/key.pem"),
    cert: readFileSync("/test-fixtures/cert.pem"),
  },
  (incoming, outgoing) => {
    const upstream = request(
      {
        hostname: "app",
        port: 3000,
        path: incoming.url,
        method: incoming.method,
        headers: { ...incoming.headers, "x-forwarded-proto": "https" },
      },
      (response) => {
        outgoing.writeHead(response.statusCode, response.headers)
        response.pipe(outgoing)
      }
    )
    upstream.on("error", () => {
      outgoing.writeHead(502)
      outgoing.end()
    })
    incoming.pipe(upstream)
  }
).listen(3443, "0.0.0.0")
