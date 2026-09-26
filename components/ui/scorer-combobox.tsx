"use client"

import Link from "next/link"
import { Plus, Triangle } from "lucide-react"
import type { ReactNode } from "react"
import { libraryScorerPreset, type ScorerInput } from "@/src/lib/tracer/scorers"
import {
  scorerLibraries,
  librarySelectionId,
  libraryEvaluator,
} from "@/src/lib/tracer/scorer-libraries"
import type { Evaluator } from "@/src/lib/tracer/contracts"
import { ComboboxMultiple } from "./combobox"
import { ScorerTypeBadge } from "./scorer-type-badge"
import { Button } from "./button"

/** Controlled scorer selection. Creation is available inside the popup by default. */
export function ScorerCombobox({
  scorers,
  value,
  onValueChange,
  createHref,
  showCreate = true,
  loading = false,
  selecting = false,
  disabled = false,
  maxSelected,
  className,
  popupStatus,
  error = false,
}: {
  scorers: Evaluator[]
  value: string[]
  onValueChange: (ids: string[]) => void
  createHref: string
  showCreate?: boolean
  selecting?: boolean
  loading?: boolean
  disabled?: boolean
  maxSelected?: number
  className?: string
  popupStatus?: ReactNode
  error?: boolean
}) {
  const libraryOptions = scorerLibraries.flatMap((library) =>
    library.evaluators.map((entry) => {
      const saved = scorers.find((scorer) => {
        const config = scorer.activeVersion.config
        return (
          config?.type === "library" &&
          config.slug === libraryScorerPreset(entry.id).slug &&
          config.library?.evaluator === entry.id &&
          config.library.version === library.version &&
          config.library.adapterVersion === library.adapterVersion
        )
      })
      const config =
        saved?.activeVersion.config ?? libraryScorerPreset(entry.id)
      return {
        value: saved?.id ?? librarySelectionId(entry.id),
        label: entry.name,
        group: library.name,
        description: entry.modelRequired
          ? `${entry.description} Uses ${saved?.activeVersion.config?.model ?? "openai/gpt-4.1-mini"} through your project's AI Gateway.`
          : entry.description,
        descriptionBelow: true,
        keywords: [library.name, entry.id, entry.name],
        badge: <ScorerTypeBadge type="library" />,
        preview: (
          <ScorerDetails
            name={saved?.name ?? entry.name}
            description={saved?.description ?? entry.description}
            type="library"
            config={config}
            revision={saved?.activeVersion.version}
          />
        ),
      }
    })
  )
  const options = [
    ...scorers
      .filter(
        (scorer) => !libraryOptions.some((option) => option.value === scorer.id)
      )
      .map((scorer) => {
        const type =
          scorer.activeVersion.config?.type ?? scorer.activeVersion.language
        return {
          value: scorer.id,
          label: scorer.name,
          group: "This project",
          leading: (
            <Triangle
              aria-hidden
              className="size-4 shrink-0 text-foreground-muted"
            />
          ),
          description: scorer.description ?? undefined,
          descriptionBelow: true,
          badge: <ScorerTypeBadge type={type} />,
          preview: (
            <ScorerDetails
              name={scorer.name}
              description={scorer.description}
              type={type}
              config={scorer.activeVersion.config}
              revision={scorer.activeVersion.version}
            />
          ),
          keywords: [
            type,
            scorer.activeVersion.config?.library?.evaluator ?? "",
            scorer.activeVersion.config?.library?.package ?? "",
            type === "javascript" ? "JS" : type,
            scorer.description ?? "",
          ],
        }
      }),
    ...libraryOptions,
    ...value
      .filter(
        (id) =>
          !scorers.some((scorer) => scorer.id === id) &&
          !libraryOptions.some((option) => option.value === id)
      )
      .map((id) => ({ value: id, label: id, group: "This project" })),
  ]
  return (
    <ComboboxMultiple
      label="Scorers"
      className={className}
      placeholder={loading ? "Loading scorers…" : "Select scorers"}
      icon={<Triangle />}
      options={options}
      disabledValues={selecting ? options.map((option) => option.value) : []}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      maxSelected={maxSelected}
      emptyContent={loading || error ? null : undefined}
      popupFooter={
        <>
          {popupStatus}
          {showCreate && (
            <div className="border-t border-border p-1">
              <Button
                asChild
                variant="ghost-muted"
                size="sm"
                className="w-full justify-start"
              >
                <Link href={createHref}>
                  <Plus aria-hidden className="size-4" />
                  New scorer
                </Link>
              </Button>
            </div>
          )}
        </>
      }
    />
  )
}

function ScorerDetails({
  name,
  description,
  type,
  config,
  revision,
}: {
  name: string
  description: string | null
  type: ScorerInput["type"]
  config?: ScorerInput
  revision?: number
}) {
  const library = type === "library" ? config?.library : undefined
  const entry = library && libraryEvaluator(library.evaluator)
  const argumentNames = {
    input: "Input",
    output: "Output",
    expected: "Reference answer",
  }
  const details = [
    ...(library ? [["Library", `AutoEvals ${library.version}`]] : []),
    ...(entry
      ? [
          [
            "Requires",
            entry.arguments
              .map((argument) => argumentNames[argument])
              .join(", "),
          ],
          [
            "Values",
            { json: "JSON", string: "Text", number: "Numbers" }[
              entry.valueType
            ],
          ],
        ]
      : []),
    ...(config?.model && (type === "llm" || entry?.modelRequired)
      ? [["Model", config.model]]
      : []),
    ...(config?.threshold != null
      ? [["Pass threshold", `Score ≥ ${config.threshold}`]]
      : []),
    ...(revision != null ? [["Revision", String(revision)]] : []),
  ]
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-medium break-words">{name}</p>
        <ScorerTypeBadge type={type} />
      </div>
      <p className="break-words whitespace-pre-wrap text-foreground-muted">
        {description?.trim() || "No description provided."}
      </p>
      {details.length > 0 && (
        <dl className="space-y-2 text-xs">
          {details.map(([label, value]) => (
            <div
              key={label}
              className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3"
            >
              <dt className="text-foreground-muted">{label}</dt>
              <dd className="break-words">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {entry && !entry.modelRequired && (
        <p className="text-xs text-foreground-muted">
          Runs without a language model.
        </p>
      )}
    </div>
  )
}
