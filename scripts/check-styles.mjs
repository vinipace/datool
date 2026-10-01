import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const palette =
  "(?:black|white|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3})"
const utility =
  "(?:bg|text|border(?:-[trblxy])?|ring(?:-offset)?|outline|divide|decoration|accent|fill|stroke|shadow|from|via|to)"
const literalColor =
  /#[\da-f]{3,8}\b|\b(?:rgb|hsl|oklch|oklab|lab|lch|color)(?:a)?\(/i
const namedColor =
  /(?:^|[:_\[])(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink)(?=[_\]]|$)/i

// Migrated files are always strict, even if a baseline entry is accidentally added.
export const strictFiles = new Set([
  "app/(app)/sign-in/page.tsx",
  "app/(app)/sign-up/page.tsx",
  "components/auth/auth-shell.tsx",
  "components/auth/google-sign-in.tsx",
  "components/workspace/api-keys-page.tsx",
  ...[
    "trace-list",
    "trace-list-table",
    "trace-list-histogram",
    "trace-list-toolbar",
    "traces-page",
    "performance-page",
    "collection-table-styles",
  ].map(
    (name) =>
      `components/tracer/${name}.${name === "collection-table-styles" ? "ts" : "tsx"}`
  ),
  ...[
    "button",
    "input",
    "select",
    "textarea",
    "checkbox",
    "switch",
    "card",
    "notice",
    "dialog",
  ].map((name) => `components/ui/${name}.tsx`),
])

export function inspectStyles(file, source) {
  if (file === "app/globals.css") return [] // The single approved palette owner.
  const found = []
  function inspect(text, offset) {
    const patterns = [
      new RegExp(
        `\\b${utility}-${palette}(?:\\/(?:[0-9]+|\\[[^\\]]+\\]))?(?![\\w-])`,
        "g"
      ),
      new RegExp(`\\b${utility}-\\[[^\\]]+\\]`, "g"),
      /\[(?:color|background(?:-color)?|border-color|fill|stroke):[^\]]+\]/g,
    ]
    for (const [index, pattern] of patterns.entries()) {
      for (const match of text.matchAll(pattern)) {
        if (
          index > 0 &&
          !literalColor.test(match[0]) &&
          !namedColor.test(match[0])
        )
          continue
        found.push({
          signature: match[0],
          line: source.slice(0, offset + match.index).split("\n").length,
        })
      }
    }
    // Literal inline/chart colors, including strings in style objects and SVG props.
    const remaining = text.replace(
      new RegExp(`\\b${utility}-\\[[^\\]]+\\]`, "g"),
      (match) => match.replace(/[^\n]/g, " ")
    )
    if (literalColor.test(remaining)) {
      for (const match of remaining.matchAll(
        /#[\da-f]{3,8}\b|\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color)\([^)]*\)/gi
      )) {
        found.push({
          signature: match[0],
          line: source.slice(0, offset + match.index).split("\n").length,
        })
      }
    }
  }
  if (file.endsWith(".css")) {
    inspect(
      source.replace(/\/\*[\s\S]*?\*\//g, (match) =>
        match.replace(/[^\n]/g, " ")
      ),
      0
    )
  } else {
    const ast = ts.createSourceFile(
      file,
      source,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    function visit(node) {
      if (
        ts.isStringLiteralLike(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node)
      ) {
        inspect(node.text, node.getStart(ast))
        const parent = ts.isJsxExpression(node.parent)
          ? node.parent.parent
          : node.parent
        const property = ts.isPropertyAssignment(parent)
          ? parent.name.getText(ast).replace(/['"]/g, "")
          : ts.isJsxAttribute(parent)
            ? parent.name.getText(ast)
            : ""
        if (
          /^(?:color|background|backgroundColor|borderColor|outlineColor|fill|stroke)$/.test(
            property
          ) &&
          /^(?:white|black|red|blue|green|gray|grey|yellow|orange|purple|pink)$/i.test(
            node.text
          )
        ) {
          found.push({
            signature: `${property}:${node.text}`,
            line: source.slice(0, node.getStart(ast)).split("\n").length,
          })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(ast)
  }
  return found
}

export function sourceFiles(directory = root) {
  const files = []
  function walk(relative) {
    for (const entry of fs.readdirSync(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = `${relative}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else if (/\.(?:tsx?|jsx?|css)$/.test(file)) files.push(file)
    }
  }
  walk("app")
  walk("components")
  return files.sort()
}

export function checkSources(sources, baseline = {}) {
  const errors = []
  for (const [file, source] of Object.entries(sources)) {
    const allowance =
      strictFiles.has(file) || file.startsWith("app/(app)/ui-reference/")
        ? {}
        : (baseline[file] ?? {})
    const used = {}
    for (const item of inspectStyles(file, source)) {
      used[item.signature] = (used[item.signature] ?? 0) + 1
      if (used[item.signature] > (allowance[item.signature] ?? 0))
        errors.push({ file, ...item })
    }
  }
  return errors
}

export function readSources() {
  return Object.fromEntries(
    sourceFiles().map((file) => [
      file,
      fs.readFileSync(path.join(root, file), "utf8"),
    ])
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const baseline = JSON.parse(
    fs.readFileSync(path.join(root, "scripts/style-baseline.json"), "utf8")
  )
  const errors = checkSources(readSources(), baseline)
  for (const error of errors)
    console.error(
      `${error.file}:${error.line}: replace ${error.signature} with a semantic token`
    )
  if (errors.length) {
    console.error(
      `${errors.length} style violation(s). See docs/ui-style-standard.md. Do not expand the baseline to hide new violations.`
    )
    process.exitCode = 1
  } else
    console.log(
      "Style contract passed: migrated files are strict; new files and additions cannot introduce hardcoded colors."
    )
}
