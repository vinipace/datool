// Test-process network interception only. Production code has no test switches.
import dns from "node:dns/promises"
import { syncBuiltinESMExports } from "node:module"
import { setupServer } from "msw/node"
import { http, passthrough } from "msw"
import { appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const lookup = dns.lookup
dns.lookup = (hostname, options) => hostname === "mcp.example.com"
  ? Promise.resolve(options?.all ? [{ address: "1.1.1.1", family: 4 }] : { address: "1.1.1.1", family: 4 })
  : lookup(hostname, options)
syncBuiltinESMExports()
const server = setupServer(http.all("*", async ({ request }) => {
  const url = new URL(request.url)
  if (["127.0.0.1", "localhost"].includes(url.hostname)) return passthrough()
  await appendFile(join(tmpdir(), "datool-eve-network.log"), `${request.method} ${url.hostname}${url.pathname}\n`)
  return fetch(`${process.env.DATOOL_EVE_TEST_UPSTREAM_URL}/upstream`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() }),
  })
}))
server.listen({ onUnhandledRequest: "error" })
// The production bridge imports Node's request functions by name. Publish the
// intercepted functions to those ESM bindings as well as CommonJS consumers.
syncBuiltinESMExports()
