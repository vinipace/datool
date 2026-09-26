"use client"

import { useState } from "react"
import { Combobox } from "@/components/ui/combobox"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/ui/notice"
import { InspectorSection } from "@/components/ui/inspector-section"
import { Switch } from "@/components/ui/switch"
import {
  defaultLibraryScorer,
  libraryEvaluator,
  scorerLibraries,
  type LibraryEvaluatorId,
} from "@/src/lib/tracer/scorer-libraries"
import { GATEWAY_PROVIDER } from "@/src/lib/model-providers"
import type { ScorerInput } from "@/src/lib/tracer/scorers"
import { ProjectModelField } from "./project-model-field"

export function LibraryScorerForm({
  config,
  onChange,
  onValidityChange,
  disabled = false,
}: {
  config: ScorerInput
  onChange: (config: ScorerInput) => void
  onValidityChange: (valid: boolean) => void
  disabled?: boolean
}) {
  const library = config.library ?? defaultLibraryScorer()
  const entry = libraryEvaluator(library.evaluator)
  return (
    <fieldset disabled={disabled} className="min-w-0">
      <FormRow label="Library">
        <span className="text-sm">AutoEvals · {library.version}</span>
      </FormRow>
      <FormRow label="Evaluator">
        <Combobox
          label="Library evaluator"
          disabled={disabled}
          value={library.evaluator}
          options={scorerLibraries[0].evaluators.map((item) => ({
            value: item.id,
            label: item.name,
            description: item.description,
            descriptionBelow: true,
            keywords: [item.id],
          }))}
          onValueChange={(id) => {
            onValidityChange(true)
            onChange({
              ...config,
              library: {
                ...defaultLibraryScorer(id as LibraryEvaluatorId),
                mappings: library.mappings,
              },
              provider: GATEWAY_PROVIDER,
              modelType: "language",
            })
          }}
        />
      </FormRow>
      <p className="px-3 py-3 text-sm text-foreground-muted">
        {entry.description}{" "}
        {entry.modelRequired
          ? "Uses your project's model provider and incurs model usage."
          : "Runs without a model or provider key."}
      </p>
      {entry.modelRequired && (
        <>
          <ProjectModelField
            includeDatoolScorer
            model={config.model}
            provider={config.provider}
            disabled={disabled}
            onChange={(selection) => onChange({ ...config, ...selection })}
          />
          <FormRow label="Include reasoning" htmlFor="library-reasoning">
            <Switch
              id="library-reasoning"
              checked={config.chainOfThought}
              onCheckedChange={(chainOfThought) =>
                onChange({ ...config, chainOfThought })
              }
            />
          </FormRow>
        </>
      )}
      <InspectorSection label="Input fields" variant="form" defaultOpen>
        <p className="mb-3 text-xs text-foreground-muted">
          Select fields with dotted paths, such as trace.output.answer or
          datasetItem.expectedOutput. Required values are checked before
          scoring.
        </p>
        <div className="grid gap-3">
          {entry.arguments.map((argument) => (
            <label key={argument} className="grid gap-1 text-sm">
              <span>{argument}</span>
              <Input
                aria-label={`Library ${argument} field`}
                value={library.mappings[argument] ?? ""}
                onChange={(event) =>
                  onChange({
                    ...config,
                    library: {
                      ...library,
                      mappings: {
                        ...library.mappings,
                        [argument]: event.target.value,
                      },
                    },
                  })
                }
              />
            </label>
          ))}
        </div>
      </InspectorSection>
      {entry.id === "ValidJSON" && (
        <JsonSchemaField
          key={entry.id}
          config={config}
          onChange={onChange}
          onValidityChange={onValidityChange}
        />
      )}
    </fieldset>
  )
}

function JsonSchemaField({
  config,
  onChange,
  onValidityChange,
}: Pick<
  Parameters<typeof LibraryScorerForm>[0],
  "config" | "onChange" | "onValidityChange"
>) {
  const [text, setText] = useState(
    config.library?.options.schema
      ? JSON.stringify(config.library.options.schema, null, 2)
      : ""
  )
  const [error, setError] = useState("")
  return (
    <InspectorSection label="JSON Schema (optional)" variant="form" defaultOpen>
      <Textarea
        aria-label="JSON Schema"
        value={text}
        rows={5}
        placeholder={'{"type":"object","required":["answer"]}'}
        onChange={(event) => {
          setText(event.target.value)
          try {
            const schema = event.target.value.trim()
              ? JSON.parse(event.target.value)
              : undefined
            if (
              schema !== undefined &&
              (!schema || typeof schema !== "object" || Array.isArray(schema))
            )
              throw new Error()
            onChange({
              ...config,
              library: {
                ...config.library!,
                options: schema ? { schema } : {},
              },
            })
            setError("")
            onValidityChange(true)
          } catch {
            setError("Enter a JSON object for the schema.")
            onValidityChange(false)
          }
        }}
      />
      {error && (
        <Notice variant="error" role="alert">
          {error}
        </Notice>
      )}
    </InspectorSection>
  )
}
