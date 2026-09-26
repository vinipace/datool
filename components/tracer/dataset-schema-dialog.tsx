"use client"

import * as React from "react"
import { WandSparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { JsonSchemaForm } from "@/components/ui/json-schema-form"
import { Notice } from "@/components/ui/notice"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type {
  DatasetField,
  DatasetFieldSchemas,
  DatasetItem,
  JsonObject,
  JsonValue,
} from "@/src/lib/tracer/contracts"
import {
  assertDatasetSchemas,
  datasetFieldErrors,
  datasetFieldLabels,
  datasetFields,
  inferDatasetSchema,
} from "@/src/lib/tracer/dataset-schemas"

export function DatasetSchemaDialog({
  schemas,
  sample,
  onClose,
  onSave,
}: {
  schemas: DatasetFieldSchemas
  sample?: DatasetItem
  onClose: () => void
  onSave: (schemas: DatasetFieldSchemas) => Promise<void>
}) {
  const [field, setField] = React.useState<DatasetField>("input")
  const [draft, setDraft] = React.useState(
    () =>
      Object.fromEntries(
        datasetFields.map((key) => [
          key,
          {
            text: schemas[key]?.schema
              ? JSON.stringify(schemas[key]!.schema, null, 2)
              : "",
            enforced: schemas[key]?.enforced ?? false,
          },
        ])
      ) as Record<DatasetField, { text: string; enforced: boolean }>
  )
  const [preview, setPreview] = React.useState<Record<DatasetField, JsonValue>>(
    {
      input: sample?.input ?? {},
      expectedOutput: sample?.expectedOutput ?? {},
      metadata: sample?.metadata ?? {},
    }
  )
  const [error, setError] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const panelId = React.useId()
  const triggerId = (key: DatasetField) => `${panelId}-${key}-tab`
  let schema: JsonObject | null = null
  let schemaError = ""
  try {
    if (draft[field].text.trim()) {
      const parsed = JSON.parse(draft[field].text)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
        throw new Error("Use a JSON Schema object.")
      schema = parsed
      assertDatasetSchemas({ [field]: { schema, enforced: false } })
    }
  } catch (reason) {
    schemaError = (reason as Error).message
  }
  const previewErrors = !schemaError
    ? datasetFieldErrors(schema, preview[field])
    : []
  const update = (patch: Partial<{ text: string; enforced: boolean }>) => {
    setError("")
    setDraft((current) => ({
      ...current,
      [field]: { ...current[field], ...patch },
    }))
  }
  async function save() {
    setError("")
    try {
      const next = Object.fromEntries(
        datasetFields.map((key) => {
          const text = draft[key].text.trim()
          const parsed = text ? JSON.parse(text) : null
          if (
            parsed !== null &&
            (typeof parsed !== "object" || Array.isArray(parsed))
          )
            throw new Error(
              `${datasetFieldLabels[key]} schema must be an object.`
            )
          return [key, { schema: parsed, enforced: draft[key].enforced }]
        })
      ) as DatasetFieldSchemas
      assertDatasetSchemas(next)
      setSaving(true)
      await onSave(next)
      onClose()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose()
      }}
    >
      <DialogContent className="flex h-[min(860px,92dvh)] w-[96vw] max-w-[1400px] flex-col gap-0 overflow-hidden bg-background p-0">
        <DialogHeader className="shrink-0 p-5 pb-3">
          <DialogTitle>Dataset schemas</DialogTitle>
          <DialogDescription>
            Define JSON schemas for input, expected output, and metadata.
            Enforced schemas apply when rows are saved or imported; existing
            rows are preserved.
          </DialogDescription>
        </DialogHeader>
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-border px-5 pb-3">
          <Tabs
            value={field}
            onValueChange={(value) => setField(value as DatasetField)}
          >
            <TabsList aria-label="Dataset schema fields">
              {datasetFields.map((key) => (
                <TabsTrigger
                  aria-controls={panelId}
                  id={triggerId(key)}
                  key={key}
                  value={key}
                >
                  {datasetFieldLabels[key]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <Button size="sm" loading={saving} onClick={() => void save()}>
            Save schemas
          </Button>
        </div>
        {error && (
          <Notice variant="error" role="alert" className="m-4 shrink-0">
            {error}
          </Notice>
        )}
        <div
          aria-labelledby={triggerId(field)}
          className="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-2"
          id={panelId}
          role="tabpanel"
        >
          <div className="flex min-h-80 flex-col gap-4 p-5 md:border-r md:border-border">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-xs text-foreground-muted">
                JSON Schema · Draft 7
              </span>
              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs">
                  <Switch
                    aria-label={`Enforce ${datasetFieldLabels[field]} schema`}
                    checked={draft[field].enforced}
                    onCheckedChange={(enforced) => update({ enforced })}
                  />
                  Enforce
                </label>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    update({
                      text: JSON.stringify(
                        inferDatasetSchema(sample?.[field] ?? preview[field]),
                        null,
                        2
                      ),
                    })
                  }
                >
                  <WandSparkles className="size-3.5" />
                  Infer from example
                </Button>
              </div>
            </div>
            <CodeEditor
              key={field}
              label={`${datasetFieldLabels[field]} schema`}
              language="json"
              value={draft[field].text}
              onChange={(text) => update({ text })}
              className="min-h-64 flex-1"
            />
            {schemaError && (
              <p role="alert" className="text-xs text-destructive">
                {schemaError}
              </p>
            )}
          </div>
          <div className="flex min-h-64 flex-col gap-5 p-5">
            <p className="text-xs text-foreground-muted">Form preview</p>
            {schema && !schemaError ? (
              <JsonSchemaForm
                key={field}
                schema={schema}
                value={preview[field]}
                onChange={(value) =>
                  setPreview((current) => ({ ...current, [field]: value }))
                }
              />
            ) : (
              <div className="flex flex-1 items-center justify-center text-sm text-foreground-muted">
                Write a schema to preview its fields.
              </div>
            )}
            {schema && !schemaError && (
              <p role="status" className="text-xs text-foreground-muted">
                {previewErrors.length
                  ? `Example validation: ${previewErrors.join("; ")}`
                  : "This example matches the schema."}
              </p>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
