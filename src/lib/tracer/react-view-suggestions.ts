import ts from "typescript"
import { pointerValue, valueType, type ViewRequirement } from "./react-views"

/** Suggestions only: never executes code or claims to infer its complete contract. */
export function suggestViewRequirements(code: string, sample: unknown) {
  const source = ts.createSourceFile(
    "view.tsx",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const suggestions = new Map<string, ViewRequirement>()
  const methods = new Set([
    "map",
    "filter",
    "find",
    "some",
    "every",
    "reduce",
    "forEach",
    "join",
    "slice",
    "includes",
    "length",
  ])
  const encode = (parts: string[]) =>
    "/" +
    parts
      .map((part) => part.replaceAll("~", "~0").replaceAll("/", "~1"))
      .join("/")
  function path(node: ts.Node): string[] | null {
    if (ts.isIdentifier(node) && node.text === "trace") return []
    if (ts.isPropertyAccessExpression(node)) {
      const root = path(node.expression)
      return root && [...root, node.name.text]
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      (ts.isStringLiteral(node.argumentExpression) ||
        ts.isNumericLiteral(node.argumentExpression))
    ) {
      const root = path(node.expression)
      return root && [...root, node.argumentExpression.text]
    }
    return null
  }
  function visit(node: ts.Node) {
    const parts = path(node)
    if (
      parts?.length &&
      !(
        ts.isPropertyAccessExpression(node.parent) ||
        ts.isElementAccessExpression(node.parent)
      )
    ) {
      if (methods.has(parts.at(-1)!)) parts.pop()
      if (parts.length) {
        const pointer = encode(parts)
        const sampleValue = pointerValue(sample, pointer)
        const text = node.getText(source)
        suggestions.set(pointer, {
          path: pointer,
          type: sampleValue == null ? "any" : valueType(sampleValue),
          required: !text.includes("?."),
          nonEmpty: false,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return {
    requirements: [...suggestions.values()].slice(0, 100),
    notice:
      "Review these suggestions before accepting. Aliases, dynamic paths and conditional reads may need manual requirements; example values do not prove required types.",
  }
}
