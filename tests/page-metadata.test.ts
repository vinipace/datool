import { describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { pageMetadata, pageTitles, rootMetadata } from "../lib/page-metadata"

const appDirectory = fileURLToPath(new URL("../app", import.meta.url))

// These pages only redirect. A route that starts rendering must declare metadata.
const redirectPages = new Set([
  "(app)/reports/page.tsx",
  "(app)/reports/new/page.tsx",
  "(app)/reports/[reportNumber]/page.tsx",
  "(marketing)/product/page.tsx",
  "(app)/agents/page.tsx",
  "(app)/dashboards/page.tsx",
  "(app)/playground/page.tsx",
  "(app)/scorers/page.tsx",
  "(app)/datasets/page.tsx",
  "(app)/datasets/[datasetId]/page.tsx",
  "(app)/evals/page.tsx",
  "(app)/evals/[evalId]/page.tsx",
  "(app)/evals/compare/page.tsx",
  "(app)/sessions/page.tsx",
  "(app)/sessions/[sessionId]/page.tsx",
  "(app)/traces/page.tsx",
  "(app)/traces/[traceId]/page.tsx",
  "(app)/workflows/page.tsx",
  "(app)/scores/new/page.tsx",
  "(app)/scorers/new/page.tsx",
  "(app)/scorers/[scorerId]/page.tsx",
  "(app)/p/[projectSlug]/page.tsx",
  "(app)/p/[projectSlug]/settings/alerts/page.tsx",
  "(app)/p/[projectSlug]/evals/compare/page.tsx",
  "(app)/p/[projectSlug]/scores/new/page.tsx",
])

function pageFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return pageFiles(path)
    return /^page\.(tsx?|jsx?|mdx)$/.test(entry.name) ? [path] : []
  })
}

function exportsMetadata(source: ts.SourceFile) {
  return source.statements.some((statement) => {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      return statement.exportClause.elements.some((entry) =>
        ["metadata", "generateMetadata"].includes(entry.name.text)
      )
    }
    if (
      !ts.canHaveModifiers(statement) ||
      !ts
        .getModifiers(statement)
        ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    )
      return false
    if (ts.isFunctionDeclaration(statement))
      return statement.name?.text === "generateMetadata"
    return (
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some(
        (entry) =>
          ts.isIdentifier(entry.name) &&
          ["metadata", "generateMetadata"].includes(entry.name.text)
      )
    )
  })
}

function containsNode(
  source: ts.Node,
  predicate: (node: ts.Node) => boolean
): boolean {
  if (predicate(source)) return true
  return source.getChildren().some((child) => containsNode(child, predicate))
}

describe("page metadata contract", () => {
  test("every rendered page declares server metadata, including aliases", () => {
    const files = pageFiles(appDirectory)
    const missing: string[] = []
    for (const file of files) {
      const path = relative(appDirectory, file)
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TSX
      )
      if (redirectPages.has(path)) {
        assert.equal(
          containsNode(
            source,
            (node) =>
              ts.isCallExpression(node) &&
              ["redirect", "permanentRedirect"].includes(
                node.expression.getText(source)
              )
          ),
          true,
          `${path} must still redirect`
        )
        assert.equal(
          containsNode(
            source,
            (node) =>
              ts.isJsxElement(node) ||
              ts.isJsxSelfClosingElement(node) ||
              ts.isJsxFragment(node)
          ),
          false,
          `${path} now renders UI and must declare metadata`
        )
        continue
      }
      const clientPage = source.statements.some(
        (statement) =>
          ts.isExpressionStatement(statement) &&
          ts.isStringLiteral(statement.expression) &&
          statement.expression.text === "use client"
      )
      assert.equal(
        clientPage,
        false,
        `${path}: keep the metadata owner on the server`
      )
      if (!exportsMetadata(source)) missing.push(path)
    }
    assert.deepEqual(
      missing,
      [],
      "Add pageMetadata() to these pages; see docs/page-metadata.md"
    )
    for (const path of redirectPages) {
      expect(files.map((file) => relative(appDirectory, file))).toContain(path)
    }
  })

  test("the brand is applied once by the root title template", () => {
    expect(rootMetadata.title).toEqual({
      default: "Datool",
      template: "%s · Datool",
    })
    for (const page of Object.keys(pageTitles) as (keyof typeof pageTitles)[]) {
      const title = pageMetadata(page).title
      expect(typeof title).toBe("string")
      expect((title as string).trim()).not.toBe("")
      expect(title).not.toContain("Datool")
    }
  })

  test("detail and creation pages have specific titles", () => {
    for (const [detail, collection] of [
      ["traceDetail", "traces"],
      ["datasetDetail", "datasets"],
      ["dashboardDetail", "dashboards"],
      ["sessionDetail", "sessions"],
      ["evalDetail", "evals"],
      ["newScorer", "scorers"],
      ["scorerDetail", "scorers"],
    ] as const) {
      expect(pageMetadata(detail).title).not.toBe(
        pageMetadata(collection).title
      )
    }
  })
})
