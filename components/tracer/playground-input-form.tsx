"use client"

import * as React from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { InspectorSection } from "@/components/ui/inspector-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/base-select"
import {
  schemaDefault,
  schemaObject,
  schemaProperties,
  updateInputProperty,
  usesJsonEditor,
  type InputSchema,
} from "@/src/lib/playground/input-form"

export function PlaygroundInputForm({
  schema,
  value,
  onChange,
}: {
  schema: InputSchema
  value: unknown
  onChange: (value: unknown) => void
}) {
  if (usesJsonEditor(schema))
    return (
      <InspectorSection label="Input" variant="form">
        <SchemaField
          schema={schema}
          value={value}
          onChange={onChange}
          label="Input"
          required
        />
      </InspectorSection>
    )
  return (
    <>
      {schemaProperties(schema).map(([key, child]) => (
        <InspectorSection
          key={key}
          label={typeof child.title === "string" ? child.title : key}
          variant="form"
        >
          <SchemaField
            schema={child}
            value={schemaObject(value)[key]}
            label={key}
            required={
              Array.isArray(schema.required) && schema.required.includes(key)
            }
            onChange={(next) => onChange(updateInputProperty(value, key, next))}
          />
        </InspectorSection>
      ))}
    </>
  )
}

function SchemaField({
  schema,
  value,
  onChange,
  label,
  required,
}: {
  schema: InputSchema
  value: unknown
  onChange: (value: unknown) => void
  label: string
  required: boolean
}) {
  const id = React.useId()
  const enumValues = Array.isArray(schema.enum) ? schema.enum : null
  const description =
    typeof schema.description === "string" ? schema.description : null
  const help = (
    <p id={`${id}-help`} className="mb-2 text-xs text-foreground-muted">
      {description ? `${description} · ` : ""}
      {required ? "Required" : "Optional"}
    </p>
  )
  const props = {
    id,
    "aria-label": label,
    "aria-describedby": `${id}-help`,
    required,
  }
  let control: React.ReactNode
  if (schema.const !== undefined) {
    control = <Input {...props} readOnly value={JSON.stringify(schema.const)} />
  } else if (enumValues) {
    const index = enumValues.findIndex(
      (item) => JSON.stringify(item) === JSON.stringify(value)
    )
    control = (
      <Select
        items={[
          { value: "unset", label: "Choose a value" },
          ...enumValues.map((item, index) => ({
            value: String(index),
            label: typeof item === "string" ? item : JSON.stringify(item),
          })),
        ]}
        value={index < 0 ? "unset" : String(index)}
        onValueChange={(next) =>
          onChange(next === "unset" ? undefined : enumValues[Number(next)])
        }
      >
        <SelectTrigger {...props}>
          <SelectValue placeholder="Choose a value" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unset">Choose a value</SelectItem>
          {enumValues.map((item, index) => (
            <SelectItem key={index} value={String(index)}>
              {typeof item === "string" ? item : JSON.stringify(item)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    )
  } else if (usesJsonEditor(schema)) {
    control = <JsonInput {...props} value={value} onChange={onChange} />
  } else if (schema.type === "boolean") {
    control = required ? (
      <Switch
        id={id}
        aria-label={label}
        checked={value === true}
        onCheckedChange={onChange}
      />
    ) : (
      <Select
        value={value === undefined ? "unset" : String(value)}
        onValueChange={(next) =>
          onChange(next === "unset" ? undefined : next === "true")
        }
      >
        <SelectTrigger {...props}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="unset">Not set</SelectItem>
          <SelectItem value="true">True</SelectItem>
          <SelectItem value="false">False</SelectItem>
        </SelectContent>
      </Select>
    )
  } else if (schema.type === "object" || schema.type === "array") {
    const included = required || value !== undefined
    control = (
      <div className="space-y-3">
        {!required && (
          <div className="flex items-center gap-2">
            <Switch
              id={id}
              checked={included}
              aria-label={`Include ${label}`}
              onCheckedChange={(checked) =>
                onChange(checked ? (schemaDefault(schema) ?? {}) : undefined)
              }
            />
            <label htmlFor={id} className="text-sm">
              Include {label}
            </label>
          </div>
        )}
        {included &&
          (schema.type === "object" ? (
            schemaProperties(schema).map(([key, child]) => (
              <div key={key} className="space-y-2 border-l border-border pl-3">
                <p className="text-sm">
                  {typeof child.title === "string" ? child.title : key}
                </p>
                <SchemaField
                  label={`${label}.${key}`}
                  schema={child}
                  value={schemaObject(value)[key]}
                  required={
                    Array.isArray(schema.required) &&
                    schema.required.includes(key)
                  }
                  onChange={(next) =>
                    onChange(updateInputProperty(value, key, next))
                  }
                />
              </div>
            ))
          ) : (
            <ArrayInput
              schema={schema}
              value={value}
              onChange={onChange}
              label={label}
            />
          ))}
      </div>
    )
  } else if (schema.type === "number" || schema.type === "integer") {
    control = (
      <Input
        {...props}
        type="number"
        step={schema.type === "integer" ? 1 : "any"}
        min={typeof schema.minimum === "number" ? schema.minimum : undefined}
        max={typeof schema.maximum === "number" ? schema.maximum : undefined}
        value={typeof value === "number" ? value : ""}
        onChange={(event) =>
          onChange(
            event.target.value === "" ? undefined : Number(event.target.value)
          )
        }
      />
    )
  } else {
    control = (
      <Textarea
        {...props}
        autoSize
        rows={1}
        required={required && typeof schema.minLength === "number" && schema.minLength > 0}
        value={typeof value === "string" ? value : ""}
        minLength={
          typeof schema.minLength === "number" ? schema.minLength : undefined
        }
        maxLength={
          typeof schema.maxLength === "number" ? schema.maxLength : undefined
        }
        onChange={(event) =>
          onChange(
            !required && event.target.value === ""
              ? undefined
              : event.target.value
          )
        }
      />
    )
  }
  return (
    <>
      {help}
      {control}
    </>
  )
}

function ArrayInput({
  schema,
  value,
  onChange,
  label,
}: {
  schema: InputSchema
  value: unknown
  onChange: (value: unknown) => void
  label: string
}) {
  const items = Array.isArray(value) ? value : []
  const child = schemaObject(schema.items)
  return (
    <div className="space-y-3">
      {items.map((item, index) => (
        <div key={index} className="space-y-2 border-l border-border pl-3">
          <div className="flex items-center justify-between">
            <p className="text-sm">Item {index + 1}</p>
            <Button
              type="button"
              variant="ghost-muted"
              size="icon-sm"
              aria-label={`Remove ${label} item ${index + 1}`}
              onClick={() =>
                onChange(items.filter((_, itemIndex) => index !== itemIndex))
              }
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <SchemaField
            schema={child}
            value={item}
            label={`${label}.${index + 1}`}
            required
            onChange={(next) =>
              onChange(
                items.map((current, itemIndex) =>
                  index === itemIndex ? next : current
                )
              )
            }
          />
        </div>
      ))}
      <Button
        type="button"
        variant="ghost-muted"
        size="sm"
        disabled={
          typeof schema.maxItems === "number" && items.length >= schema.maxItems
        }
        onClick={() => onChange([...items, schemaDefault(child) ?? null])}
      >
        <Plus className="size-3.5" />
        Add {label} item
      </Button>
    </div>
  )
}

function JsonInput({
  value,
  onChange,
  ...props
}: Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> & {
  value: unknown
  onChange: (value: unknown) => void
}) {
  const serialized = JSON.stringify(value, null, 2) ?? ""
  const [draft, setDraft] = React.useState(serialized)
  const [previous, setPrevious] = React.useState(serialized)
  if (serialized !== previous) {
    setPrevious(serialized)
    setDraft(serialized)
  }
  return (
    <Textarea
      {...props}
      className="min-h-36 font-mono text-xs"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value)
        try {
          const next = event.target.value.trim()
            ? JSON.parse(event.target.value)
            : undefined
          event.target.setCustomValidity("")
          onChange(next)
        } catch {
          event.target.setCustomValidity("Enter valid JSON")
        }
      }}
    />
  )
}
