import { expect, test } from "bun:test"
import assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { z } from "zod"

import {
  procedureDefinitionSchema,
  widgetDefinitionSchema,
} from "@/src/lib/build/contracts"
import { withWorkspace } from "@/src/server/auth/context"
import { createMcpServer } from "@/src/server/mcp/server"
import type { TracerService } from "@/src/server/tracer/service"
import { configureBuildTestEnvironment } from "./helpers/build-env"

configureBuildTestEnvironment()

async function withClient(
  scopes: string[],
  run: (client: Client) => Promise<void>
) {
  // Static authoring operations need a configured handle, but never connect.
  const previousUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL ??= "postgresql://unused:unused@127.0.0.1:1/unused"
  const server = createMcpServer({} as TracerService, scopes)
  const client = new Client({ name: "authoring-contract", version: "1" })
  const [serverTransport, clientTransport] =
    InMemoryTransport.createLinkedPair()
  try {
    await withWorkspace(
      {
        organizationId: "authoring-test",
        projectId: "authoring-test",
        scopes,
        kind: "api-key",
      },
      async () => {
        await server.connect(serverTransport)
        await client.connect(clientTransport)
        await run(client)
      }
    )
  } finally {
    await client.close()
    await server.close()
    if (previousUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = previousUrl
  }
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
) {
  const result = await client.callTool({ name, arguments: args })
  assert(!result.isError, JSON.stringify(result.content))
  return z.object({ data: z.unknown() }).parse(result.structuredContent).data
}

test("MCP discovers templates and returns editable disabled definitions with translations", async () => {
  await withClient(["build:read"], async (client) => {
    const summarySchema = z.array(
      z.object({ id: z.string(), category: z.string(), name: z.string() })
    )
    for (const kind of ["widget", "skill"] as const) {
      const listName = `build_list_${kind}_templates`
      const raw = await call(client, listName)
      const summaries = summarySchema.parse(raw)
      expect(summaries.length).toBeGreaterThan(0)
      expect(new Set(summaries.map((item) => item.id)).size).toBe(
        summaries.length
      )
      expect(
        (raw as Record<string, unknown>[]).every(
          (item) => !("definition" in item)
        )
      ).toBe(true)
      const first = summaries[0]!
      const filtered = summarySchema.parse(
        await call(client, listName, {
          search: first.name.toUpperCase(),
          category: first.category.toLowerCase(),
        })
      )
      expect(filtered.map((item) => item.id)).toContain(first.id)
      expect(filtered.every((item) => item.category === first.category)).toBe(
        true
      )
      expect(
        await call(client, listName, { category: "no-such-category" })
      ).toEqual([])

      for (const { id } of summaries) {
        const template = z
          .object({ id: z.string(), definition: z.unknown() })
          .parse(await call(client, `build_get_${kind}_template`, { id }))
        expect(template.id).toBe(id)
        if (kind === "widget") {
          const definition = widgetDefinitionSchema.parse(template.definition)
          expect(definition.enabled).toBe(false)
          expect(definition.code?.length).toBeGreaterThan(0)
          for (const locale of ["pt-BR", "es"])
            expect(Object.keys(definition.translations ?? {})).toContain(locale)
          expect(definition.functions.every((fn) => fn.actionId === null)).toBe(
            true
          )
        } else {
          const definition = procedureDefinitionSchema.parse(
            template.definition
          )
          expect(definition.enabled).toBe(false)
          expect(definition.instructions?.length).toBeGreaterThan(0)
          expect(definition.actionRefs).toEqual([])
        }
      }
      const missing = await client.callTool({
        name: `build_get_${kind}_template`,
        arguments: { id: "does-not-exist" },
      })
      expect(missing.isError).toBe(true)
      const content = z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .parse(missing.content)
      expect(JSON.parse(content[0]!.text).code).toBe("NOT_FOUND")
    }
  })
})

test("MCP authoring schemas validate their examples and reject invalid author input", async () => {
  await withClient(["build:read"], async (client) => {
    const ajv = new Ajv2020({ strict: false })
    addFormats(ajv)
    for (const [topic, invalid] of [
      ["agent", { model: 42 }],
      ["action", { type: "unknown-action" }],
      ["skill", { trigger: { type: "unknown-trigger" } }],
      ["widget", { translations: { "pt-BR": { Name: 42 } } }],
    ] as const) {
      const guide = z
        .object({
          topic: z.string(),
          schema: z.record(z.string(), z.unknown()),
          example: z.record(z.string(), z.unknown()),
        })
        .parse(await call(client, "build_get_authoring_guide", { topic }))
      expect(guide.topic).toBe(topic)
      const validate = ajv.compile(guide.schema)
      assert(
        validate(guide.example),
        `${topic}: ${JSON.stringify(validate.errors)}`
      )
      expect(validate({ ...guide.example, ...invalid })).toBe(false)
    }
    const components = z
      .object({
        imports: z.array(z.string()),
        components: z.array(
          z.object({
            name: z.string(),
            props: z.record(z.string(), z.string()),
          })
        ),
      })
      .parse(await call(client, "build_get_widget_components"))
    expect(components.imports).toContain("@datool/widgets")
    expect(
      components.components.find((item) => item.name === "Form")?.props
        .onSubmitAction
    ).toBe("Action (required)")
    for (const args of [{ topic: "invalid" }, {}]) {
      expect(
        (
          await client.callTool({
            name: "build_get_authoring_guide",
            arguments: args,
          })
        ).isError
      ).toBe(true)
    }
  })
})

test("MCP authoring calls require read permission even for write-capable clients", async () => {
  await withClient(["build:write"], async (client) => {
    const names = (await client.listTools()).tools.map((tool) => tool.name)
    expect(names).not.toContain("build_get_authoring_guide")
    expect(names).not.toContain("build_list_widget_templates")
    expect(
      (
        await client.callTool({
          name: "build_get_authoring_guide",
          arguments: { topic: "widget" },
        })
      ).isError
    ).toBe(true)
  })
})
