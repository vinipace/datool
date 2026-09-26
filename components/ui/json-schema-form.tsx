"use client"

import { Input } from "./input"
import { Select } from "./select"
import { Switch } from "./switch"
import { Textarea } from "./textarea"
import type { JsonObject, JsonValue } from "@/src/lib/tracer/contracts"

/** A lightweight schema preview. Complex unions and arrays remain editable as JSON. */
export function JsonSchemaForm({
  schema,
  value,
  onChange,
  name = "Value",
  depth = 0,
}: {
  schema: JsonObject
  value: JsonValue
  onChange: (value: JsonValue) => void
  name?: string
  depth?: number
}) {
  const type = Array.isArray(schema.type)
    ? schema.type.find((item) => item !== "null")
    : schema.type
  if (type === "object" && depth < 8) {
    const properties =
      schema.properties &&
      typeof schema.properties === "object" &&
      !Array.isArray(schema.properties)
        ? schema.properties
        : {}
    const object =
      value && typeof value === "object" && !Array.isArray(value) ? value : {}
    return (
      <div className="grid gap-4">
        {Object.entries(properties).length === 0 && (
          <p className="py-6 text-center text-sm text-foreground-muted">
            Add properties to preview this object.
          </p>
        )}
        {Object.entries(properties).map(([key, child]) =>
          child && typeof child === "object" && !Array.isArray(child) ? (
            <div key={key} className="grid gap-2">
              <div className="text-xs text-foreground-muted">
                {key}
                {Array.isArray(schema.required) && schema.required.includes(key)
                  ? " *"
                  : ""}
              </div>
              <JsonSchemaForm
                schema={child}
                name={`${name}.${key}`}
                value={object[key] ?? null}
                depth={depth + 1}
                onChange={(next) => onChange({ ...object, [key]: next })}
              />
              {typeof child.description === "string" && (
                <p className="text-xs text-foreground-muted">
                  {child.description}
                </p>
              )}
            </div>
          ) : null
        )}
      </div>
    )
  }
  if (Array.isArray(schema.enum))
    return (
      <Select
        aria-label={name}
        value={JSON.stringify(value)}
        onChange={(event) => onChange(JSON.parse(event.target.value))}
      >
        <option value="null">Choose a value</option>
        {schema.enum.map((option) => (
          <option key={JSON.stringify(option)} value={JSON.stringify(option)}>
            {typeof option === "string" ? option : JSON.stringify(option)}
          </option>
        ))}
      </Select>
    )
  if (type === "boolean")
    return (
      <Switch
        aria-label={name}
        checked={value === true}
        onCheckedChange={onChange}
      />
    )
  if (type === "string" || type === "number" || type === "integer")
    return (
      <Input
        aria-label={name}
        type={type === "string" ? "text" : "number"}
        step={type === "integer" ? 1 : "any"}
        value={
          typeof value === "string" || typeof value === "number" ? value : ""
        }
        onChange={(event) =>
          onChange(
            type === "string"
              ? event.target.value
              : event.target.value === ""
                ? null
                : Number(event.target.value)
          )
        }
      />
    )
  return (
    <Textarea
      key={JSON.stringify(schema)}
      aria-label={`${name} JSON`}
      defaultValue={JSON.stringify(value, null, 2)}
      onBlur={(event) => {
        try {
          onChange(JSON.parse(event.target.value))
        } catch {
          /* Retain invalid text until the sample is corrected. */
        }
      }}
      className="min-h-24 font-mono text-xs"
    />
  )
}
