import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const [appId, endpoint, destination] = process.argv.slice(2)
if (!/^plugin_asdk_app_[a-zA-Z0-9]+$/.test(appId ?? "")) {
  throw new Error(
    "Pass the registered ChatGPT plugin_asdk_app ID, HTTPS MCP URL, and optional output directory."
  )
}
const url = new URL(endpoint)
if (
  url.protocol !== "https:" ||
  url.username ||
  url.password ||
  url.search ||
  url.hash ||
  url.pathname !== "/api/mcp/trace-explorer"
) {
  throw new Error(
    "Use an HTTPS origin with /api/mcp/trace-explorer and no credentials, query or fragment."
  )
}
const source = resolve(root, "plugins/datool-trace-explorer")
const output = resolve(
  root,
  destination ?? "artifacts/plugins/datool-trace-explorer"
)
if (!output.startsWith(resolve(root, "artifacts") + "/"))
  throw new Error(
    "Generated personal packages must stay under ignored artifacts/."
  )
await mkdir(output, { recursive: true })
await cp(source, output, { recursive: true })
const mcp = JSON.parse(await readFile(resolve(source, "mcp.json"), "utf8"))
mcp.mcpServers["datool-trace-explorer"].url = url.href
await writeFile(
  resolve(output, "mcp.json"),
  JSON.stringify(mcp, null, 2) + "\n"
)
await writeFile(
  resolve(output, ".app.json"),
  JSON.stringify(
    { apps: { "datool-trace-explorer": { id: appId } } },
    null,
    2
  ) + "\n"
)
console.log(`Personal Datool plugin package: ${output}`)
