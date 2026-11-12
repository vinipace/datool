import { readFileSync, writeFileSync } from "node:fs"
import { agentOpenApi } from "../src/server/mcp/openapi"
import { buildOperationCatalog } from "../src/server/build/bootstrap"

type Schema = {
  $ref?: string
  type?: string | string[]
  const?: unknown
  enum?: unknown[]
  anyOf?: Schema[]
  oneOf?: Schema[]
  items?: Schema
  properties?: Record<string, Schema>
  required?: string[]
  description?: string
}
const spec = agentOpenApi("https://your-datool-host")
function dereference(schema: Schema, root: unknown = spec): Schema {
  if (!schema.$ref) return schema
  const resolved = schema.$ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (value, key) =>
        (value as Record<string, unknown>)[
          key.replace(/~1/g, "/").replace(/~0/g, "~")
        ],
      root
    ) as Schema
  if (!resolved) throw new Error(`Unresolved schema: ${schema.$ref}`)
  return resolved
}
function typeName(schema: Schema, depth = 0, root: unknown = spec): string {
  if (depth > 4) return "JSON"
  schema = dereference(schema, root)
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const)
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(" or ")
  const union = schema.anyOf ?? schema.oneOf
  if (union)
    return [...new Set(union.map((item) => typeName(item, depth + 1, root)))].join(
      " or "
    )
  if (schema.type === "array")
    return `array of ${typeName(schema.items ?? {}, depth + 1, root)}`
  return String(schema.type ?? "JSON")
}
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ")
function fields(schema: Schema, root: unknown = spec) {
  const resolved = dereference(schema, root)
  if (!resolved.properties) return `Type: **${typeName(resolved, 0, root)}**.\n`
  return (
    [
      "| Field | Type | Required |",
      "| --- | --- | --- |",
      ...Object.entries(resolved.properties).map(
        ([name, value]) =>
          `| \`${cell(name)}\` | ${cell(typeName(value, 0, root))} | ${resolved.required?.includes(name) ? "Yes" : "No"} |`
      ),
    ].join("\n") + "\n"
  )
}
let content = `---
title: Operation reference
description: Browse request fields, response fields, and required scopes for every REST, CLI, and MCP operation.
icon: reference
---

This reference is generated from the server's registered inputs and typed service results. Call each operation with \`POST /api/agent/OPERATION_NAME\`. See [API setup](/docs/reference/api) for authentication, examples, pagination, and error handling. The [OpenAPI specification](/openapi.json) includes nested schemas and constraints; the tables below summarize top-level fields. An older deployment may expose fewer operations. Use live discovery on the target server.

All successful REST responses wrap the documented result in \`{ "data": ... }\`. Required fields describe the serialized response; null is distinct from an omitted field. Application inputs, outputs, metadata, and JSON Schemas can contain arbitrary JSON.
`
type Operation = {
  operationId: string
  description: string
  "x-required-scopes": string[]
  "x-destructive": boolean
  requestBody: { content: { "application/json": { schema: Schema } } }
  responses: { "200": { content: { "application/json": { schema: Schema } } } }
}
for (const path of Object.values(spec.paths) as { post: Operation }[]) {
  const operation = path.post
  const result =
    operation.responses["200"].content["application/json"].schema.properties!
      .data
  content += `\n## ${operation.operationId}\n\n${operation.description.replace(/[{}<>]/g, (character) => `\\${character}`)}\n\nRequired scopes: ${operation["x-required-scopes"].map((scope) => `\`${scope}\``).join(", ") || "no additional operation scopes (authentication and project access still required)"}.\n`
  content += `\n**Request fields**\n\n${fields(operation.requestBody.content["application/json"].schema)}`
  const resolved = dereference(result)
  content += `\n**Result**${resolved.type === "array" ? " — array; each item has these fields" : ""}\n\n${fields(resolved.type === "array" ? (resolved.items ?? {}) : result)}`
}

function save(path: string, generated: string) {
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== generated)
      throw new Error(`${path} is stale; run bun run generate:api`)
  } else writeFileSync(path, generated)
}
save("content/docs/reference/operations.mdx", content)

const buildCatalog = buildOperationCatalog()
let buildContent = `---
title: Build operation reference
description: Discover managed agent, integration, drive, React SDK and scheduled task operations, scopes and retry contracts.
icon: reference
---

Generated from the shared Build registry. Call these operations with \`POST /api/build/OPERATION_NAME\`, the MCP tool of the same name, or a compatible CLI's \`datool build call OPERATION_NAME --input @input.json\`. Use \`build_describe_operations\` (or \`datool build tools\`) on the target server for complete current input and available output schemas. Build must be enabled and the credential must hold every listed scope. Observe operations use a [separate endpoint and catalog](/docs/reference/operations).

Use [agent configuration and drives](/docs/guides/agents), [integrations](/docs/guides/integrations), [scheduled tasks](/docs/guides/scheduled-tasks), and [React SDK](/docs/guides/react-sdk) for workflows and examples. The tool \`build_get_authoring_guide\` returns validated examples and semantic constraints for these topics.

Successful REST results are wrapped in \`{ "data": ... }\`; MCP returns the same envelope in structuredContent. When outputSchema is advertised it describes that envelope. Required retry keys can be supplied as \`idempotencyKey\` or \`requestKey\` in tool input; REST also accepts the Idempotency-Key header. Use the current expectedRevision for revision-protected edits. Read a saved state before retrying an uncertain mutation.
`
for (const operation of buildCatalog) {
  buildContent += `\n## ${operation.name}\n\n${operation.description.replace(/[{}<>]/g, (character) => `\\${character}`)}\n\nRequired scopes: ${operation.scopes.map((scope) => `\`${scope}\``).join(", ")}. Idempotency key: **${operation.idempotency}**. Expected revision: **${operation.expectedRevision}**.\n\n**Request fields**\n\n${fields(operation.inputSchema as Schema, operation.inputSchema)}`
  if (operation.outputSchema) {
    const result = (operation.outputSchema as Schema).properties!.data
    buildContent += `\n**Result**\n\n${fields(result, operation.outputSchema)}`
  }
}
save("content/docs/reference/build-operations.mdx", buildContent)

// Read help literals without running the CLI (which would load user configuration).
const topHelp = /const usage = `([\s\S]*?)`/.exec(
  readFileSync("bin/datool.ts", "utf8")
)?.[1]
const agentHelp = /export const agentUsage = `([\s\S]*?)`/.exec(
  readFileSync("bin/agent.ts", "utf8")
)?.[1]
if (!topHelp || !agentHelp) throw new Error("CLI help literal missing")
const cliPath = "content/docs/reference/cli.mdx"
const cli = readFileSync(cliPath, "utf8")
const marker = "## Generated command reference"
const prefix = cli.split(marker)[0].trimEnd()
save(
  cliPath,
  `${prefix}\n\n${marker}\n\nGenerated from the CLI shipped with this server source. Use \`npx datool --help\` to inspect the commands installed in your project; see [compatibility](/docs/reference/compatibility) for the published baseline. Scalar flags map to operation input fields. Use \`agent tools OPERATION\` for the complete deployed schema.\n\n\`\`\`text\n${topHelp}\n\n${agentHelp}\n\`\`\`\n`
)
console.log("API operation tables and CLI help generated or verified.")
