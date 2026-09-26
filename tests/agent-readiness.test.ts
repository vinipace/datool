import { describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import Ajv2020 from "ajv/dist/2020"
import addFormats from "ajv-formats"
import { NextRequest } from "next/server"
import {
  prefersMarkdown,
  publicMarkdownPath,
  markdownNotFound,
} from "../lib/markdown-negotiation"
import { proxy } from "../proxy"
import { agentOpenApi } from "../src/server/mcp/openapi"
import { agentOperations } from "../src/server/mcp/operations"
import { apiError } from "../src/server/tracer/http"
import { apiError as auxiliaryError } from "../lib/api-response"
import { TracerError } from "../src/server/tracer/errors"
import * as missingApi from "../app/api/[[...path]]/route"
import openApiSchema from "./fixtures/openapi/schema-2022-10-07.json"

describe("public Markdown negotiation", () => {
  for (const [accept, expected] of [
    [null, false],
    ["*/*", false],
    ["text/html", false],
    ["text/markdown", true],
    ["TEXT/MARKDOWN; charset=utf-8", true],
    ["text/markdown;q=0", false],
    ["text/markdown;q=0, */*", false],
    ["text/markdown;q=0.5, text/html;q=0.9", false],
    ["text/markdown;q=0.9, text/html;q=0.5", true],
    ["text/html, text/markdown", false],
    ["text/markdown, */*", true],
    ["text/markdown;q=0.1, text/*;q=0.5", false],
    ["text/markdown;q=invalid", false],
    ["text/markdown;q=2", false],
  ] as const)
    test(`Accept ${accept} selects Markdown: ${expected}`, () => {
      expect(prefersMarkdown(accept)).toBe(expected)
    })

  test("only public content is rewritten, while private paths and methods keep their handlers", () => {
    expect(publicMarkdownPath("/")).toBe("/api/cms-markdown/landing-page")
    expect(publicMarkdownPath("/product/build")).toBe(
      "/api/cms-markdown/product/build"
    )
    expect(publicMarkdownPath("/docs/reference/mcp")).toBe(
      "/api/docs-markdown/reference/mcp"
    )
    for (const path of [
      "/p/example/traces",
      "/cms",
      "/api/traces",
      "/api/docs-markdown/reference/mcp",
      "/unknown",
    ])
      expect(publicMarkdownPath(path)).toBeNull()
    for (const method of ["GET", "HEAD", "POST"]) {
      const response = proxy(
        new NextRequest("https://datool.test/?draft=true", {
          method,
          headers: { Accept: "text/markdown", "x-datool-markdown": "forged" },
        })
      )
      expect(response.headers.get("Vary")).toBe("Accept")
      expect(
        response.headers.get("x-middleware-request-x-datool-markdown")
      ).toBe(method === "POST" ? "0" : "1")
      expect(response.headers.get("x-middleware-rewrite")).toBe(
        method === "POST"
          ? null
          : "https://datool.test/api/cms-markdown/landing-page"
      )
    }
    const response = proxy(
      new NextRequest(
        "https://datool.test/p/project/traces?filter=x&_rsc=123",
        {
          headers: {
            Accept: "text/markdown",
            "x-datool-workspace-path": "/forged",
          },
        }
      )
    )
    expect(response.headers.get("x-middleware-rewrite")).toBeNull()
    const forged = proxy(
      new NextRequest("https://datool.test/missing", {
        headers: { Accept: "text/html", "x-datool-markdown": "1" },
      })
    )
    expect(forged.headers.get("x-middleware-request-x-datool-markdown")).toBe(
      "0"
    )
    expect(
      response.headers.get("x-middleware-request-x-datool-workspace-path")
    ).toBe("/p/project/traces?filter=x")
  })

  test("docs support negotiated Markdown and explicit .md URLs without rewriting their internal handler", () => {
    for (const [path, destination] of [
      ["/docs", "/api/docs-markdown"],
      ["/docs/", "/api/docs-markdown"],
      ["/docs.md", "/api/docs-markdown"],
      ["/docs/evaluation/datasets", "/api/docs-markdown/evaluation/datasets"],
      ["/docs/evaluation/datasets.md", "/api/docs-markdown/evaluation/datasets"],
      ["/docs/missing.md", "/api/docs-markdown/missing"],
    ]) {
      expect(publicMarkdownPath(path)).toBe(destination)
      for (const method of ["GET", "HEAD", "POST"]) {
        for (const accept of [
          "text/markdown",
          "text/html",
          "*/*",
          "text/markdown;q=0, text/html",
        ]) {
          const response = proxy(
            new NextRequest(`https://datool.test${path}?example=1`, {
              method,
              headers: { Accept: accept },
            })
          )
          const rewrite =
            method !== "POST" &&
            (path.endsWith(".md") || accept === "text/markdown")
          expect(response.headers.get("x-middleware-rewrite")).toBe(
            rewrite ? `https://datool.test${destination}` : null
          )
          expect(response.headers.get("Vary")).toBe("Accept")
          if (method !== "POST" && !rewrite) {
            expect(response.headers.get("Cache-Control")).toBe("no-store")
          }
        }
      }
    }
    for (const path of [
      "/api/docs-markdown",
      "/api/docs-markdown/evaluation/datasets",
      "/p/example/traces.md",
      "/docs-assets/example.md",
    ]) {
      expect(publicMarkdownPath(path)).toBeNull()
    }
  })

  test("404 includes Markdown explanation and recovery links", async () => {
    const response = markdownNotFound()
    expect(response.status).toBe(404)
    expect(response.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8"
    )
    const body = await response.text()
    expect(body.length).toBeGreaterThan(20)
    expect(body).toContain("[documentation](/docs)")
    expect(body).toContain("[agent index](/llms.txt)")
  })
})

describe("OpenAPI 3.1 agent contract", () => {
  const document = agentOpenApi("https://datool.test")
  test("validates against the official OAS schema and resolves every local reference", () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true })
    addFormats(ajv)
    ajv.addFormat("media-range", /^[^\s/]+\/[^\s/]+$/)
    // Bind the official schema's dialect extension point to its default schema.
    // Ajv cannot resolve the nested dynamic anchor used by the OAS meta-schema.
    const schema = JSON.parse(
      JSON.stringify(openApiSchema).replaceAll(
        '"$dynamicRef":"#meta"',
        '"$ref":"#/$defs/schema"'
      )
    )
    const validate = ajv.compile(schema)
    assert.ok(validate(document), JSON.stringify(validate.errors?.slice(0, 5)))
    function walk(value: unknown) {
      if (!value || typeof value !== "object") return
      for (const [key, child] of Object.entries(value)) {
        if (key === "$ref" && typeof child === "string") {
          expect(child.startsWith("#/components/schemas/")).toBe(true)
          const resolved = child
            .slice(2)
            .split("/")
            .reduce<unknown>(
              (node, segment) =>
                (node as Record<string, unknown>)?.[
                  segment.replace(/~1/g, "/").replace(/~0/g, "~")
                ],
              document
            )
          assert.notEqual(resolved, undefined, child)
        } else walk(child)
      }
    }
    walk(document)
  })

  test("every operation publishes its actual strict input schema and required scopes", () => {
    expect(Object.keys(document.paths)).toHaveLength(agentOperations.length)
    const ajv = new Ajv2020({ strict: false, validateFormats: false })
    // Compile the complete schema tree so recursive $refs use their document pointers.
    ajv.addSchema({
      $id: "https://datool.test/contracts",
      components: document.components,
    })
    for (const operation of agentOperations) {
      const path = document.paths[`/api/agent/${operation.name}`] as {
        post: { operationId: string; security: unknown; requestBody: unknown }
      }
      expect(path.post.operationId).toBe(operation.name)
      expect(path.post.security).toEqual([
        { bearerAuth: [] },
        { oauth2: operation.scopes },
      ])
      const validate = ajv.compile({
        $ref: `https://datool.test/contracts#/components/schemas/${operation.name}_input`,
      })
      expect(validate({ unknownField: true })).toBe(false)
      assert.equal(
        validate({}),
        operation.schema.strict().safeParse({}).success,
        operation.name
      )
    }
    const validate = ajv.compile({
      $ref: "https://datool.test/contracts#/components/schemas/run_app_input",
    })
    expect(
      validate({
        id: "app",
        requestKey: "key",
        input: { nested: [1, true, null, { value: "ok" }] },
      })
    ).toBe(true)
  })
})

describe("structured JSON errors", () => {
  test("adds hints without changing codes, messages, details or retry headers", async () => {
    for (const status of [
      400, 401, 402, 403, 404, 409, 413, 422, 429, 500, 503, 504,
    ]) {
      const response = apiError(
        new TracerError("VALIDATION_ERROR", "Existing message", {
          status,
          details: { retryAfterSeconds: 2 },
        })
      )
      expect(response.status).toBe(status)
      expect(response.headers.get("cache-control")).toBe("no-store")
      const body = await response.json()
      expect(body.error).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Existing message",
        details: { retryAfterSeconds: 2 },
      })
      expect(typeof body.error.hint).toBe("string")
      if (status === 429) expect(response.headers.get("retry-after")).toBe("2")
    }
    const response = apiError(new Error("secret SQL/password"))
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret SQL/password"
    )
    expect(
      (await auxiliaryError("UNAUTHENTICATED", "Sign in", 401).json()).error
        .hint
    ).toContain("OAuth")
  })

  test("missing API routes return JSON 404 for every supported method", async () => {
    for (const method of [
      "GET",
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
    ] as const) {
      const response = missingApi[method]()
      expect(response.status).toBe(404)
      expect(response.headers.get("content-type")).toContain("application/json")
      const body = await response.json()
      expect(body.error.code).toBe("NOT_FOUND")
      expect(body.error.hint).toContain("/openapi.json")
    }
  })
})
