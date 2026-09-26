import { describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, readdirSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import GithubSlugger from "github-slugger"
import { parse } from "yaml"
import { createDatool } from "@/src/lib/tracer/client"
import { defaultPrompt } from "@/src/lib/tracer/prompts"
import { resourceDocumentSchema } from "@/src/lib/tracer/resource-document"
import { compileCollectionFilter } from "@/src/lib/tracer/collection-filters"
import { parseAlertFilter } from "@/src/lib/alerts/filter"

const root = fileURLToPath(new URL("../content/docs", import.meta.url))

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? files(path) : [path]
  })
}

const allFiles = files(root)
const pages = allFiles
  .filter((path) => path.endsWith(".mdx"))
  .map((path) => {
    const source = readFileSync(path, "utf8")
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(source)
    if (!match) throw new Error(`Missing frontmatter: ${path}`)
    const data = parse(match[1]) as { title?: string; description?: string }
    const body = match[2]
    const prose = body.replace(/^```[^\n]*\n[\s\S]*?^```\s*$/gm, "")
    const slug = relative(root, path)
      .replace(/\.mdx$/, "")
      .replace(/(^|\/)index$/, "")
    const url = `/docs${slug ? `/${slug}` : ""}`
    const slugger = new GithubSlugger()
    const headings = [...prose.matchAll(/^#{1,6}\s+(.+)$/gm)].map((heading) =>
      slugger.slug(heading[1])
    )
    return { path, source, data, body, prose, url, headings }
  })

describe("public documentation", () => {
  test("JSON examples parse and tutorial dataset files satisfy the import contract", () => {
    for (const page of pages) {
      for (const match of page.body.matchAll(/```json\n([\s\S]*?)\n```/g)) {
        const value = JSON.parse(match[1])
        if (value.format === 1 && value.kind === "dataset") {
          expect(resourceDocumentSchema.safeParse(value).success).toBe(true)
        }
      }
    }
  })

  test("copyable collection and alert filters use their respective supported grammar", () => {
    for (const page of pages.filter((page) =>
      [
        "/docs/reference/filters",
        "/docs/guides/dashboards",
        "/docs/guides/alerts",
      ].includes(page.url)
    )) {
      for (const match of page.body.matchAll(
        /```(text|sql)\n([\s\S]*?)\n```/g
      )) {
        for (const filter of match[2].split("\n").filter(Boolean)) {
          if (match[1] === "sql")
            expect(() => parseAlertFilter(filter)).not.toThrow()
          else
            expect(() =>
              compileCollectionFilter("traces", filter)
            ).not.toThrow()
        }
      }
    }
  })

  test("pages have descriptive metadata and no broken internal links or anchors", () => {
    for (const page of pages) {
      assert.ok(page.data.title?.trim(), page.path)
      assert.ok(page.data.description?.trim(), page.path)
      for (const match of page.prose.matchAll(/\[[^\]]+\]\(([^\s)]+)\)/g)) {
        const href = match[1]
        if (href.startsWith("/docs-assets/")) {
          assert.ok(
            existsSync(join(root, "../../public", href)),
            `${page.url} links to missing asset ${href}`
          )
          continue
        }
        if (
          /^https?:\/\//.test(href) ||
          ["/llms.txt", "/openapi.json"].includes(href)
        )
          continue
        const target = new URL(href, `https://docs.test${page.url}`)
        const destination = pages.find(
          (candidate) => candidate.url === target.pathname
        )
        assert.ok(destination, `${page.url} links to missing ${href}`)
        if (target.hash) {
          assert.ok(
            destination.headings.includes(
              decodeURIComponent(target.hash.slice(1))
            ),
            `${page.url} links to missing anchor ${href}`
          )
        }
      }
    }
  })

  test("each folder's navigation includes its pages and contains no stale entries", () => {
    for (const path of allFiles.filter((file) => file.endsWith("meta.json"))) {
      const directory = dirname(path)
      const metadata = JSON.parse(readFileSync(path, "utf8")) as {
        pages: string[]
      }
      const children = readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() || entry.name.endsWith(".mdx"))
        .map((entry) => entry.name.replace(/\.mdx$/, ""))
      assert.deepEqual([...metadata.pages].sort(), children.sort(), path)
    }
  })

  test("the copied prompt tutorial follows publication and its optional comparison pins versions", async () => {
    const page = pages.find(
      (page) => page.url === "/docs/get-started/first-prompt"
    )!
    const snippets = [...page.body.matchAll(/```js\n([\s\S]*?)\n```/g)]
    const requests: URL[] = []
    const printed: unknown[][] = []
    let publishedVersion = 1
    const recordingClient = () =>
      createDatool({
        baseUrl: "http://docs.test",
        projectId: "docs-test",
        apiKey: "docs-test",
        fetch: async (url) => {
          const request = new URL(String(url))
          requests.push(request)
          const version =
            Number(request.searchParams.get("version")) || publishedVersion
          return Response.json({
            data: {
              ...defaultPrompt,
              id: "docs-greeting-id",
              slug: "docs-greeting",
              name: "Docs greeting",
              model: "openai/gpt-4.1-mini",
              version,
              publishedVersion,
              messages: [
                {
                  role: "user",
                  content:
                    version === 1
                      ? "Greet {{customer}} from {{company}}."
                      : "Greet {{customer}} from {{company}} in one sentence.",
                },
              ],
            },
          })
        },
      })
    const AsyncFunction = Object.getPrototypeOf(
      async function () {}
    ).constructor
    const run = (source: string) =>
      new AsyncFunction(
        "createDatool",
        "console",
        source.replace(/^import .+ from "@datool\/sdk"\n/m, "")
      )(recordingClient, {
        log: (...values: unknown[]) => printed.push(values),
      })

    await run(snippets[0][1])
    publishedVersion = 2
    await run(snippets[0][1])
    expect(JSON.parse(String(printed[0][0]))).toMatchObject({
      version: 1,
      messages: [{ content: "Greet Ada from Example Co." }],
    })
    expect(JSON.parse(String(printed[1][0]))).toMatchObject({
      version: 2,
      messages: [{ content: "Greet Ada from Example Co in one sentence." }],
    })
    expect(requests.slice(0, 2).map((url) => url.search)).toEqual(["", ""])
    expect(
      requests.every(
        (url) => url.pathname === "/api/prompts/by-slug/docs-greeting"
      )
    ).toBe(true)

    await run(snippets[1][1])
    expect(printed.slice(2)).toEqual([
      [1, [{ role: "user", content: "Greet Ada from Example Co." }]],
      [
        2,
        [
          {
            role: "user",
            content: "Greet Ada from Example Co in one sentence.",
          },
        ],
      ],
    ])
    expect(requests.slice(2).map((url) => url.search)).toEqual([
      "?version=1",
      "?version=2",
    ])
  })
})
