import { readFileSync, writeFileSync } from "node:fs"
import { agentOpenApi } from "../src/server/mcp/openapi"

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
function dereference(schema: Schema): Schema {
  if (!schema.$ref) return schema
  const resolved = schema.$ref
    .slice(2)
    .split("/")
    .reduce<unknown>(
      (value, key) =>
        (value as Record<string, unknown>)[
          key.replace(/~1/g, "/").replace(/~0/g, "~")
        ],
      spec
    ) as Schema
  if (!resolved) throw new Error(`Unresolved schema: ${schema.$ref}`)
  return resolved
}
function typeName(schema: Schema, depth = 0): string {
  if (depth > 4) return "JSON"
  schema = dereference(schema)
  if (Object.hasOwn(schema, "const")) return JSON.stringify(schema.const)
  if (schema.enum)
    return schema.enum.map((value) => JSON.stringify(value)).join(" or ")
  const union = schema.anyOf ?? schema.oneOf
  if (union)
    return [...new Set(union.map((item) => typeName(item, depth + 1)))].join(
      " or "
    )
  if (schema.type === "array")
    return `array of ${typeName(schema.items ?? {}, depth + 1)}`
  return String(schema.type ?? "JSON")
}
const cell = (value: string) => value.replace(/\|/g, "\\|").replace(/\n/g, " ")
function fields(schema: Schema) {
  const resolved = dereference(schema)
  if (!resolved.properties) return `Type: **${typeName(resolved)}**.\n`
  return (
    [
      "| Field | Type | Required |",
      "| --- | --- | --- |",
      ...Object.entries(resolved.properties).map(
        ([name, value]) =>
          `| \`${cell(name)}\` | ${cell(typeName(value))} | ${resolved.required?.includes(name) ? "Yes" : "No"} |`
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
