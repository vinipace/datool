import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import ts from "typescript"

// Generate response documentation from the actual service callbacks. Inputs stay
// runtime-validated by Zod. This file never executes a service or opens a database.
const root = fileURLToPath(new URL("../", import.meta.url))
const sourcePath = `${root}src/server/mcp/operations.ts`
const destination = `${root}src/server/mcp/output-schemas.json`
const config = ts.readConfigFile(`${root}tsconfig.json`, ts.sys.readFile)
if (config.error)
  throw new Error(
    ts.flattenDiagnosticMessageText(config.error.messageText, "\n")
  )
const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root)
const program = ts.createProgram([sourcePath], parsed.options)
const checker = program.getTypeChecker()
const source = program.getSourceFile(sourcePath)
const definitions = {}
const operations = {}
const seen = new Map()
const F = ts.TypeFlags

function withoutUndefined(type) {
  return type.isUnion()
    ? type.types.filter((item) => !(item.flags & F.Undefined))
    : [type]
}

function ref(type, hint, build) {
  if (seen.has(type)) return { $ref: `#/components/schemas/${seen.get(type)}` }
  const symbol = type.aliasSymbol ?? type.getSymbol()
  const named = symbol?.getName()
  const base = (
    named && !["__type", "__object", "Array", "ReadonlyArray"].includes(named)
      ? named
      : hint
  )
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .slice(0, 120)
  let name = `Output_${base}`
  let suffix = 2
  while (Object.hasOwn(definitions, name)) name = `Output_${base}_${suffix++}`
  seen.set(type, name)
  definitions[name] = {} // Reserve the name before visiting recursive fields.
  definitions[name] = build()
  return { $ref: `#/components/schemas/${name}` }
}

function schema(type, hint) {
  if (type.flags & F.Any)
    throw new Error(
      `Unresolved any in ${hint}; give the service a response type`
    )
  if (type.flags & F.Unknown)
    return { description: "Application-defined JSON value." }
  if (type.flags & F.Never) return false
  if (type.flags & F.Null) return { type: "null" }
  if (type.flags & F.StringLiteral) return { type: "string", const: type.value }
  if (type.flags & F.NumberLiteral) return { type: "number", const: type.value }
  if (type.flags & F.BooleanLiteral)
    return { type: "boolean", const: type.intrinsicName === "true" }
  if (type.flags & F.String) return { type: "string" }
  if (type.flags & F.Number) return { type: "number" }
  if (type.flags & F.Boolean) return { type: "boolean" }
  if (type.flags & (F.Undefined | F.Void))
    throw new Error(`Non-JSON response at ${hint}`)
  if (type.isUnion()) {
    return ref(type, hint, () => {
      const variants = withoutUndefined(type).map((item) => schema(item, hint))
      if (variants.every((item) => Object.hasOwn(item, "const"))) {
        return { enum: variants.map((item) => item.const) }
      }
      return variants.length === 1 ? variants[0] : { anyOf: variants }
    })
  }
  if (checker.isTupleType(type)) {
    const items = checker.getTypeArguments(type)
    const target = type.target
    if (target.hasRestElement)
      throw new Error(`Unsupported rest tuple at ${hint}`)
    return {
      type: "array",
      prefixItems: items.map((item, index) => schema(item, `${hint}_${index}`)),
      minItems: target.minLength,
      maxItems: items.length,
    }
  }
  if (checker.isArrayType(type)) {
    return {
      type: "array",
      items: schema(checker.getTypeArguments(type)[0], `${hint}_item`),
    }
  }
  if (type.getSymbol()?.getName() === "Date")
    return { type: "string", format: "date-time" }
  if (type.flags & (F.Object | F.Intersection)) {
    if (type.getCallSignatures().length)
      throw new Error(`Function in response at ${hint}`)
    return ref(type, hint, () => {
      const properties = {}
      const required = []
      for (const property of checker
        .getPropertiesOfType(type)
        .sort((a, b) => a.name.localeCompare(b.name))) {
        const value = checker.getTypeOfSymbolAtLocation(
          property,
          property.valueDeclaration ?? source
        )
        // JSON.stringify omits undefined object properties, even when TS marks
        // the key required. Null remains an explicit member of the schema.
        const optional =
          Boolean(property.flags & ts.SymbolFlags.Optional) ||
          value.flags & F.Undefined ||
          (value.isUnion() &&
            value.types.some((part) => part.flags & F.Undefined))
        if (value.flags & F.Undefined) continue
        properties[property.name] = schema(value, `${hint}_${property.name}`)
        if (!optional) required.push(property.name)
      }
      const index = checker.getIndexTypeOfType(type, ts.IndexKind.String)
      return {
        type: "object",
        ...(Object.keys(properties).length ? { properties } : {}),
        ...(required.length ? { required } : {}),
        ...(index
          ? { additionalProperties: schema(index, `${hint}_value`) }
          : {}),
      }
    })
  }
  throw new Error(
    `Unsupported response type ${checker.typeToString(type)} at ${hint}`
  )
}

function operationNames(node) {
  if (ts.isStringLiteral(node)) return [node.text]
  if (ts.isTemplateExpression(node) && node.templateSpans.length === 1) {
    const span = node.templateSpans[0]
    const type = checker.getTypeAtLocation(span.expression)
    const members = type.isUnion() ? type.types : [type]
    if (members.every((member) => member.flags & F.StringLiteral)) {
      return members.map(
        (member) => `${node.head.text}${member.value}${span.literal.text}`
      )
    }
  }
  throw new Error(`Cannot enumerate operation name: ${node.getText()}`)
}

function registerOutput(name, effect) {
  if (
    effect.aliasSymbol?.name !== "TracerEffect" ||
    !effect.aliasTypeArguments?.[0]
  ) {
    throw new Error(`Expected a typed TracerEffect for ${name}`)
  }
  const output = effect.aliasTypeArguments[0]
  if (output.flags & (F.Unknown | F.Any))
    throw new Error(`Missing response contract for ${name}`)
  if (Object.hasOwn(operations, name))
    throw new Error(`Duplicate response contract for ${name}`)
  operations[name] = schema(output, name)
}

function visit(node) {
  if (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "tool"
  ) {
    const action = node.arguments[4]
    const signature = checker.getSignaturesOfType(
      checker.getTypeAtLocation(action),
      ts.SignatureKind.Call
    )[0]
    const effect = checker.getReturnTypeOfSignature(signature)
    for (const name of operationNames(node.arguments[0])) {
      registerOutput(name, effect)
    }
  }
  ts.forEachChild(node, visit)
}
visit(source)

// Views share a catalog across HTTP, MCP and WebMCP. Read names from that
// catalog and infer each result from the dispatcher's actual return expression,
// before its public TracerEffect<unknown> annotation erases the result type.
// Like tool() callbacks above, this is static analysis: no service is executed.
const viewDispatcher = program.getSourceFile(`${root}src/server/tracer/view-operations.ts`)
const viewCatalog = program.getSourceFile(`${root}src/lib/tracer/view-operations.ts`)
const viewEffects = new Map()
function visitViewDispatch(node) {
  if (ts.isCaseClause(node) && ts.isStringLiteral(node.expression)) {
    const returns = []
    function visitReturn(child) {
      if (ts.isReturnStatement(child)) {
        if (child.expression) returns.push(child.expression)
        return
      }
      if (!ts.isFunctionLike(child)) ts.forEachChild(child, visitReturn)
    }
    node.statements.forEach(visitReturn)
    if (returns.length !== 1)
      throw new Error(`Expected one typed return for View action ${node.expression.text}`)
    viewEffects.set(node.expression.text, checker.getTypeAtLocation(returns[0]))
    return
  }
  ts.forEachChild(node, visitViewDispatch)
}
visitViewDispatch(viewDispatcher)
function registerView(action, name) {
  if (!action || !ts.isStringLiteral(action) || !viewEffects.has(action.text))
    throw new Error(`Missing typed View action for ${name?.getText()}`)
  for (const operation of operationNames(name))
    registerOutput(operation, viewEffects.get(action.text))
}
function visitViewCatalog(node) {
  if (ts.isCallExpression(node)) {
    if (ts.isIdentifier(node.expression) && node.expression.text === "add")
      registerView(node.arguments[0], node.arguments[1])
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.getText() === "viewOperations" &&
      node.expression.name.text === "push"
    ) {
      for (const entry of node.arguments) {
        if (!ts.isObjectLiteralExpression(entry))
          throw new Error("Expected a literal View operation catalog entry")
        const property = (name) => entry.properties.find(
          (item) => ts.isPropertyAssignment(item) && item.name.getText() === name
        )?.initializer
        // The add() helper's shorthand entry is handled at its call sites.
        if (property("name")) registerView(property("action"), property("name"))
      }
    }
  }
  ts.forEachChild(node, visitViewCatalog)
}
visitViewCatalog(viewCatalog)

const sort = (object) =>
  Object.fromEntries(
    Object.entries(object).sort(([a], [b]) => a.localeCompare(b))
  )
const content = `${JSON.stringify({ operations: sort(operations), schemas: sort(definitions) }, null, 2)}\n`
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== content) {
    throw new Error(
      "Agent response schemas are stale. Run bun run generate:api."
    )
  }
} else {
  writeFileSync(destination, content)
}
console.log(
  `${Object.keys(operations).length} typed agent responses ${process.argv.includes("--check") ? "verified" : "generated"}.`
)
