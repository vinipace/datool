export type InputSchema = Record<string, unknown>

export function schemaObject(value: unknown): InputSchema {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as InputSchema)
    : {}
}

export function schemaProperties(schema: InputSchema) {
  return Object.entries(schemaObject(schema.properties)).map(
    ([key, value]) => [key, schemaObject(value)] as const
  )
}

export function usesJsonEditor(schema: InputSchema) {
  return (
    Boolean(
      schema.$ref ||
      schema.oneOf ||
      schema.anyOf ||
      schema.allOf ||
      Array.isArray(schema.type)
    ) ||
    !["string", "number", "integer", "boolean", "object", "array"].includes(
      String(schema.type)
    ) ||
    (schema.type === "object" && !schemaProperties(schema).length) ||
    (schema.type === "array" && (!schema.items || Array.isArray(schema.items)))
  )
}

/** Apply declared defaults without inventing values for optional fields. */
export function schemaDefault(schema: InputSchema): unknown {
  if (schema.default !== undefined) return structuredClone(schema.default)
  if (schema.const !== undefined) return structuredClone(schema.const)
  if (usesJsonEditor(schema)) return undefined
  if (schema.type === "object") {
    const required = Array.isArray(schema.required) ? schema.required : []
    return Object.fromEntries(
      schemaProperties(schema).flatMap(([key, child]) => {
        const value = schemaDefault(child)
        return value !== undefined &&
          (required.includes(key) ||
            child.default !== undefined ||
            child.const !== undefined)
          ? [[key, value]]
          : []
      })
    )
  }
  if (schema.type === "array") return []
  if (schema.type === "boolean") return false
  if (schema.type === "string" && !schema.enum) return ""
  return undefined
}

export function initialAppInput(
  schema: InputSchema,
  defaultInput?: unknown
): unknown {
  if (defaultInput === undefined) return schemaDefault(schema) ?? {}
  if (
    schema.type === "object" &&
    defaultInput &&
    typeof defaultInput === "object" &&
    !Array.isArray(defaultInput)
  ) {
    const input = {
      ...schemaObject(schemaDefault(schema)),
      ...schemaObject(defaultInput),
    }
    for (const [key, child] of schemaProperties(schema)) {
      if (Object.hasOwn(input, key))
        input[key] = initialAppInput(child, input[key])
    }
    return structuredClone(input)
  }
  if (schema.type === "array" && Array.isArray(defaultInput)) {
    return defaultInput.map((item) =>
      initialAppInput(schemaObject(schema.items), item)
    )
  }
  return structuredClone(defaultInput)
}

export function updateInputProperty(
  value: unknown,
  key: string,
  next: unknown
) {
  const result = { ...schemaObject(value) }
  if (next === undefined) delete result[key]
  else
    Object.defineProperty(result, key, {
      value: next,
      enumerable: true,
      configurable: true,
      writable: true,
    })
  return result
}
