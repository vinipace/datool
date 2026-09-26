import { existsSync, readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const slash = (value) => value.split(path.sep).join("/")

function filesUnder(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const location = path.join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(location) : [location]
  })
}

function sourceFile(file) {
  return ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  )
}

function localImports(root, file) {
  const result = []
  for (const statement of sourceFile(file).statements) {
    if (
      !ts.isImportDeclaration(statement) &&
      !ts.isExportDeclaration(statement)
    )
      continue
    if (
      !statement.moduleSpecifier ||
      !ts.isStringLiteral(statement.moduleSpecifier)
    )
      continue
    if (ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly)
      continue
    if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause
      if (
        !clause?.name &&
        clause?.namedBindings &&
        ts.isNamedImports(clause.namedBindings) &&
        clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((entry) => entry.isTypeOnly)
      )
        continue
    }
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause) &&
      statement.exportClause.elements.length > 0 &&
      statement.exportClause.elements.every((entry) => entry.isTypeOnly)
    )
      continue
    const specifier = statement.moduleSpecifier.text
    const base = specifier.startsWith("@/")
      ? path.join(root, specifier.slice(2))
      : specifier.startsWith(".")
        ? path.resolve(path.dirname(file), specifier)
        : null
    if (!base) continue
    const candidate = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${base}/index.ts`,
      `${base}/index.tsx`,
    ].find((item) => /\.[cm]?[jt]sx?$/.test(item) && existsSync(item))
    if (candidate) result.push(candidate)
  }
  return result
}

function reaches(root, start, target, imports) {
  const pending = [start]
  const seen = new Set()
  while (pending.length) {
    const file = pending.pop()
    if (file === target) return true
    if (seen.has(file)) continue
    seen.add(file)
    if (!imports.has(file)) imports.set(file, localImports(root, file))
    pending.push(...imports.get(file))
  }
  return false
}

function hasStoryExports(file) {
  const source = sourceFile(file)
  return (
    source.statements.some(ts.isExportAssignment) &&
    source.statements.some(
      (statement) =>
        ts.isVariableStatement(statement) &&
        statement.modifiers?.some(
          (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
        ) &&
        statement.declarationList.declarations.some(
          (declaration) =>
            ts.isIdentifier(declaration.name) &&
            /^[A-Z]/.test(declaration.name.text)
        )
    )
  )
}

function containsJsx(file) {
  let found = false
  const visit = (node) => {
    if (
      ts.isJsxElement(node) ||
      ts.isJsxSelfClosingElement(node) ||
      ts.isJsxFragment(node)
    )
      found = true
    if (!found) ts.forEachChild(node, visit)
  }
  visit(sourceFile(file))
  return found
}

/** Structural coverage is paired with actual browser tests; it is not visual proof. */
export function checkCoverage(root, { builtIndex = false } = {}) {
  const components = filesUnder(path.join(root, "components"))
    .filter((file) => file.endsWith(".tsx") && !file.endsWith(".stories.tsx"))
    .map((file) => slash(path.relative(root, file)))
    .sort()
  const discovered = new Set(components)
  const entries = []
  const errors = []
  for (const file of filesUnder(path.join(root, ".storybook/coverage")).filter(
    (file) => file.endsWith(".json")
  )) {
    try {
      const data = JSON.parse(readFileSync(file, "utf8"))
      if (!Array.isArray(data)) throw new Error("Expected an array")
      entries.push(...data)
    } catch (error) {
      errors.push(`${slash(path.relative(root, file))}: ${error.message}`)
    }
  }
  const classified = new Set()
  const stories = new Set()
  const imports = new Map()
  const totals = { direct: 0, composite: 0, helper: 0 }
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.component !== "string" ||
      !Object.hasOwn(totals, entry.kind)
    ) {
      errors.push(`Invalid coverage entry: ${JSON.stringify(entry)}`)
      continue
    }
    const { component, kind, story, reason } = entry
    if (classified.has(component))
      errors.push(`Duplicate classification: ${component}`)
    classified.add(component)
    totals[kind]++
    if (!discovered.has(component))
      errors.push(`Stale or out-of-scope component: ${component}`)
    if (kind !== "direct" && (typeof reason !== "string" || !reason.trim())) {
      errors.push(`${component}: ${kind} requires a reason`)
    }
    if (kind === "helper") {
      if (story !== undefined)
        errors.push(`${component}: helpers must not declare a story`)
      if (
        discovered.has(component) &&
        containsJsx(path.resolve(root, component))
      )
        errors.push(
          `${component}: JSX-rendering modules require visual coverage`
        )
      continue
    }
    if (
      typeof story !== "string" ||
      !story.startsWith("components/") ||
      story.includes("..") ||
      !story.endsWith(".stories.tsx")
    ) {
      errors.push(`${component}: expected a component story path`)
      continue
    }
    if (
      kind === "direct" &&
      story !== component.replace(/\.tsx$/, ".stories.tsx")
    ) {
      errors.push(`${component}: direct coverage requires an adjacent story`)
    }
    const storyPath = path.resolve(root, story)
    if (!existsSync(storyPath)) {
      errors.push(`${component}: missing story ${story}`)
      continue
    }
    if (!stories.has(story) && !hasStoryExports(storyPath)) {
      errors.push(
        `${story}: expected CSF default metadata and named story exports`
      )
    }
    stories.add(story)
    if (
      discovered.has(component) &&
      !reaches(root, storyPath, path.resolve(root, component), imports)
    ) {
      errors.push(
        `${component}: unreachable from ${story} through runtime imports`
      )
    }
  }
  for (const component of components) {
    if (!classified.has(component))
      errors.push(`Missing classification: ${component}`)
  }
  for (const story of filesUnder(path.join(root, "components")).filter((file) =>
    file.endsWith(".stories.tsx")
  )) {
    const relative = slash(path.relative(root, story))
    if (!stories.has(relative)) errors.push(`Untracked story: ${relative}`)
  }
  if (builtIndex) {
    try {
      const index = JSON.parse(
        readFileSync(path.join(root, "storybook-static/index.json"), "utf8")
      )
      const indexed = new Set(
        Object.values(index.entries)
          .filter((entry) => entry.type === "story")
          .map((entry) => entry.importPath?.replace(/^\.\//, ""))
      )
      for (const story of stories) {
        if (!indexed.has(story))
          errors.push(`${story}: missing from built Storybook index`)
      }
    } catch (error) {
      errors.push(`Cannot inspect built Storybook index: ${error.message}`)
    }
  }
  return { components, totals, stories: [...stories].sort(), errors }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2)
  if (args.some((arg) => arg !== "--built-index")) {
    console.error("Usage: bun run storybook:coverage [--built-index]")
    process.exitCode = 1
  } else {
    const result = checkCoverage(
      path.resolve(fileURLToPath(new URL("..", import.meta.url))),
      {
        builtIndex: args.includes("--built-index"),
      }
    )
    console.log(
      `Storybook: ${result.components.length} component files; ${result.totals.direct} direct, ${result.totals.composite} composite, ${result.totals.helper} nonvisual; ${result.stories.length} story files.`
    )
    if (result.errors.length) {
      console.error(result.errors.join("\n"))
      process.exitCode = 1
    } else {
      console.log(
        "All component files are classified and visual targets are reachable from stories."
      )
    }
  }
}
