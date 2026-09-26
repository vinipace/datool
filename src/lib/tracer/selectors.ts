import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"

const forbiddenSegments = new Set(["__proto__", "constructor", "prototype"])
const identifierSegment = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const arrayIndexSegment = /^\d+$/

/**
 * Parses the small, data-only selector language used by saved views.
 * It deliberately excludes bracket notation, function calls, and prototype
 * names; a numeric segment can only traverse an array index.
 */
export function parseSelector(selector: string): string[] | null {
  if (!selector || selector.length > 300) {
    return null
  }
  const segments = selector.split(".")
  if (
    segments.some(
      (segment) =>
        !segment ||
        forbiddenSegments.has(segment) ||
        (!identifierSegment.test(segment) && !arrayIndexSegment.test(segment)),
    )
  ) {
    return null
  }
  return segments
}

export function isSafeSelector(selector: string) {
  return parseSelector(selector) !== null
}

/** Returns undefined for a missing path, rather than evaluating arbitrary code. */
export function resolveJsonSelector(value: JsonValue, selector: string): JsonValue | undefined {
  const segments = parseSelector(selector)
  if (!segments) {
    return undefined
  }

  let current: JsonValue | undefined = value
  for (const segment of segments) {
    if (Array.isArray(current)) {
      if (!arrayIndexSegment.test(segment)) {
        return undefined
      }
      const index = Number(segment)
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        return undefined
      }
      current = current[index]
      continue
    }
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      return undefined
    }
    current = (current as JsonObject)[segment]
  }
  return current
}
