"use client"

import { PanelActionLabel } from "@/components/ui/panel-action-label"
import * as React from "react"
import { ListChecks, Layers, Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Notice } from "@/components/ui/notice"
import { ChoiceCard } from "@/components/ui/choice-card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Combobox, ComboboxMultiple } from "@/components/ui/combobox"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import {
  humanScoreInputSchema,
  humanScoreTypeLabel,
  type HumanScore,
  type HumanScoreInput,
  type HumanScoreCollection,
  type HumanScoreLibrary,
} from "@/src/lib/tracer/human-scores"
import { CollectionPanel } from "./collection-panel"
import { HeaderSlot } from "./collection-header"
import { CollectionPage, CollectionSearch } from "./collection-page"
import { CollectionTable, CollectionTableBody, CollectionRow, CollectionRowSelection, CollectionSelectAll } from "./collection-table"
import { collectionTable } from "./collection-table-styles"
import { EmptyState, ErrorState, LoadingState } from "./primitives"
import { useMutation, useRemote } from "./hooks"
import { tracerApi } from "./api"
import { humanScoreIcon } from "./human-score-icon"

export function HumanScoresPage() {
  const library = useRemote(tracerApi.humanScores.library, [])
  const [tab, setTab] = React.useState("scores")
  const [search, setSearch] = React.useState("")
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(new Set())
  const [editing, setEditing] = React.useState<HumanScore | "new" | null>(null)
  const [collection, setCollection] = React.useState<
    HumanScoreCollection | "new" | null
  >(null)
  const rows = (
    tab === "scores"
      ? (library.data?.scores ?? [])
      : (library.data?.collections ?? [])
  ).filter((row) =>
    `${row.name} ${row.description}`
      .toLowerCase()
      .includes(search.toLowerCase())
  )
  const panel = (
    <CollectionPanel label="Human Scores">
      <CollectionPage
        className="contents"
        state={library}
        loadingLabel="Loading Human Scores"
        selection={{
          rows: rows.filter((row) => checkedIds.has(row.id)),
          onClear: () => setCheckedIds(new Set()),
        }}
        header={{
          exportRows: rows,
          exportName: tab === "scores" ? "human-scores" : "human-score-collections",
          children: (
            <CollectionSearch
              label="Search Human Scores"
              value={search}
              onChange={setSearch}
            />
          ),
          actions: (
            <Button
              size="sm"
              disabled={!library.data}
              onClick={() =>
                tab === "scores" ? setEditing("new") : setCollection("new")
              }
            >
              <Plus className="size-4" />
              <PanelActionLabel>{tab === "scores" ? "New Human Score" : "New collection"}</PanelActionLabel>
            </Button>
          ),
        }}
        isEmpty={!rows.length}
        empty={
          <EmptyState
            icon={tab === "scores" ? ListChecks : Layers}
            title={
              search
                ? "No matching entries"
                : tab === "scores"
                  ? "No Human Scores yet"
                  : "No collections yet"
            }
            detail={
              tab === "scores"
                ? "Define the criteria people use to review traces."
                : "Group Human Scores to reuse the same criteria across review sessions."
            }
          />
        }
      >
        <CollectionTable
          persistenceKey={`human-scores:${tab}`}
          fillHeight
          columnIds={["name", "type", "description"]}
          widths={[260, 220, 420]}
        >
          <thead className={collectionTable.head}>
            <tr>
              <th className={collectionTable.heading} scope="col">
                <CollectionSelectAll
                  label={`Select all ${tab === "scores" ? "Human Scores" : "collections"}`}
                  checked={rows.length > 0 && rows.every((row) => checkedIds.has(row.id))}
                  partial={rows.some((row) => checkedIds.has(row.id)) && !rows.every((row) => checkedIds.has(row.id))}
                  disabled={!rows.length}
                  onChange={() => setCheckedIds(rows.every((row) => checkedIds.has(row.id)) ? new Set() : new Set(rows.map((row) => row.id)))}
                />
              </th>
              {[
                "Name",
                tab === "scores" ? "Type" : "Human Scores",
                "Description",
              ].map((label) => (
                <th key={label} className={collectionTable.heading} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <CollectionTableBody rows={rows} empty="No entries.">
            {(row, index) => (
              <CollectionRow
                key={row.id}
                checked={checkedIds.has(row.id)}
                onClick={() =>
                  "type" in row ? setEditing(row) : setCollection(row)
                }
              >
                <CollectionRowSelection
                  index={index}
                  checked={checkedIds.has(row.id)}
                  label={`Select ${row.name}`}
                  onChange={() => setCheckedIds((current) => {
                    const next = new Set(current)
                    if (next.has(row.id)) next.delete(row.id)
                    else next.add(row.id)
                    return next
                  })}
                />
                <td className={collectionTable.cell}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      "type" in row ? setEditing(row) : setCollection(row)
                    }
                  >
                    {row.name}
                  </Button>
                </td>
                <td className={collectionTable.cell}>
                  {"type" in row
                    ? humanScoreTypeLabel(row)
                    : `${row.scoreIds.length} scores`}
                </td>
                <td className={collectionTable.cell}>{row.description || "—"}</td>
              </CollectionRow>
            )}
          </CollectionTableBody>
        </CollectionTable>
      </CollectionPage>
    </CollectionPanel>
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        setTab(value)
        setCheckedIds(new Set())
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <HeaderSlot name="tabs">
        <TabsList variant="panel" aria-label="Human Score library">
          <TabsTrigger value="scores">
            <ListChecks className="size-4" />
            Human Scores
          </TabsTrigger>
          <TabsTrigger value="collections">
            <Layers className="size-4" />
            Collections
          </TabsTrigger>
        </TabsList>
      </HeaderSlot>
      {["scores", "collections"].map(value => (
        <TabsContent key={value} value={value} className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col">
          {panel}
        </TabsContent>
      ))}
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null)
        }}
      >
        {editing && (
          <HumanScoreDialog
            initial={editing === "new" ? undefined : editing}
            onSaved={() => {
              setEditing(null)
              library.refresh()
            }}
          />
        )}
      </Dialog>
      <Dialog
        open={collection !== null}
        onOpenChange={(open) => {
          if (!open) setCollection(null)
        }}
      >
        {collection && library.data && (
          <HumanCollectionDialog
            initial={collection === "new" ? undefined : collection}
            library={library.data}
            onSaved={() => {
              setCollection(null)
              library.refresh()
            }}
          />
        )}
      </Dialog>
    </Tabs>
  )
}

export function HumanScoreDialog({
  initial,
  initialName = "",
  onSaved,
}: {
  initial?: HumanScore
  initialName?: string
  onSaved: (score: HumanScore) => void
}) {
  const mutation = useMutation()
  const [name, setName] = React.useState(initial?.name ?? initialName)
  const [description, setDescription] = React.useState(
    initial?.description ?? ""
  )
  const [type, setType] = React.useState(
    initial?.type === "categorical"
      ? initial.multiple
        ? "multiple"
        : "categorical"
      : (initial?.type ?? "numeric")
  )
  const [min, setMin] = React.useState(
    String(initial?.type === "numeric" ? initial.min : 0)
  )
  const [max, setMax] = React.useState(
    String(initial?.type === "numeric" ? initial.max : 1)
  )
  const [step, setStep] = React.useState(
    String(initial?.type === "numeric" ? initial.step : 0.01)
  )
  const [maxLength, setMaxLength] = React.useState(
    String(initial?.type === "text" ? initial.maxLength : 4000)
  )
  const [options, setOptions] = React.useState(
    initial?.type === "categorical"
      ? initial.options
      : [
          { value: crypto.randomUUID(), label: "" },
          { value: crypto.randomUUID(), label: "" },
        ]
  )
  const [error, setError] = React.useState("")
  const typeId = React.useId()
  async function save(event: React.FormEvent) {
    event.preventDefault()
    setError("")
    const input: HumanScoreInput =
      type === "numeric"
        ? {
            name,
            description,
            type,
            min: Number(min),
            max: Number(max),
            step: Number(step),
          }
        : type === "text"
          ? { name, description, type, maxLength: Number(maxLength) }
          : {
              name,
              description,
              type: "categorical",
              multiple: type === "multiple",
              options,
            }
    const parsed = humanScoreInputSchema.safeParse(input)
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join(" "))
      return
    }
    try {
      onSaved(
        await mutation.run(() =>
          initial
            ? tracerApi.humanScores.update(
                initial.id,
                initial.revision,
                parsed.data
              )
            : tracerApi.humanScores.create(parsed.data)
        )
      )
    } catch {
      // The mutation displays its error and preserves the form.
    }
  }
  return (
    <DialogContent
      className="max-w-xl"
      onInteractOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {initial ? "Edit Human Score" : "Create Human Score"}
        </DialogTitle>
        <DialogDescription>
          Reusable criteria for people reviewing traces.
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={save} className="space-y-4">
        <fieldset className="space-y-4" disabled={mutation.isPending}>
          <label className="grid gap-1.5 text-sm">
            Name
            <Input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Forecast accuracy"
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            Description
            <Textarea
              autoSize
              rows={2}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Explain what to look for…"
            />
          </label>
          <fieldset className="space-y-2">
            <legend className="mb-2 text-sm">Score type</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ["numeric", "Numeric slider"],
                ["categorical", "Single choice"],
                ["multiple", "Multiple choice"],
                ["text", "Free text"],
              ].map(([value, label]) => (
                <ChoiceCard
                  key={value}
                  name={typeId}
                  value={value}
                  checked={type === value}
                  onChange={() => setType(value)}
                >
                  {label}
                </ChoiceCard>
              ))}
            </div>
          </fieldset>
          {type === "numeric" && (
            <div className="grid grid-cols-3 gap-3">
              {[
                ["Minimum", min, setMin],
                ["Maximum", max, setMax],
                ["Step", step, setStep],
              ].map(([label, value, setter]) => (
                <label key={String(label)} className="grid gap-1.5 text-sm">
                  {String(label)}
                  <Input
                    required
                    type="number"
                    step="any"
                    value={String(value)}
                    onChange={(event) =>
                      (setter as React.Dispatch<React.SetStateAction<string>>)(
                        event.target.value
                      )
                    }
                  />
                </label>
              ))}
            </div>
          )}
          {type === "text" && (
            <label className="grid gap-1.5 text-sm">
              Maximum characters
              <Input
                type="number"
                required
                min={1}
                max={16000}
                value={maxLength}
                onChange={(event) => setMaxLength(event.target.value)}
              />
            </label>
          )}
          {(type === "categorical" || type === "multiple") && (
            <div className="space-y-2">
              <p className="text-sm">Options</p>
              {options.map((option, index) => (
                <div key={option.value} className="flex gap-2">
                  <Input
                    aria-label={`Option ${index + 1}`}
                    required
                    maxLength={120}
                    value={option.label}
                    placeholder={`Option ${index + 1}`}
                    onChange={(event) =>
                      setOptions((current) =>
                        current.map((row) =>
                          row.value === option.value
                            ? { ...row, label: event.target.value }
                            : row
                        )
                      )
                    }
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove option ${index + 1}`}
                    disabled={options.length <= 2}
                    onClick={() =>
                      setOptions((current) =>
                        current.filter((row) => row.value !== option.value)
                      )
                    }
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={options.length >= 50}
                onClick={() =>
                  setOptions((current) => [
                    ...current,
                    { value: crypto.randomUUID(), label: "" },
                  ])
                }
              >
                <Plus className="size-4" />
                Add option
              </Button>
            </div>
          )}
          {(error || mutation.error) && (
            <Notice variant="error">{error || mutation.error?.message}</Notice>
          )}
          <Button type="submit" disabled={mutation.isPending}>
            {mutation.isPending
              ? "Saving…"
              : initial
                ? "Save changes"
                : "Create Human Score"}
          </Button>
        </fieldset>
      </form>
    </DialogContent>
  )
}

function HumanCollectionDialog({
  initial,
  library,
  onSaved,
}: {
  initial?: HumanScoreCollection
  library: HumanScoreLibrary
  onSaved: () => void
}) {
  const [name, setName] = React.useState(initial?.name ?? "")
  const [description, setDescription] = React.useState(
    initial?.description ?? ""
  )
  const [scoreIds, setScoreIds] = React.useState(initial?.scoreIds ?? [])
  const mutation = useMutation()
  return (
    <DialogContent
      className="max-w-xl"
      onInteractOutside={(event) => event.preventDefault()}
      onEscapeKeyDown={(event) => {
        if (mutation.isPending) event.preventDefault()
      }}
    >
      <DialogHeader>
        <DialogTitle>
          {initial ? "Edit collection" : "New Human Score collection"}
        </DialogTitle>
        <DialogDescription>
          Choose Human Scores in the order people should review them.
        </DialogDescription>
      </DialogHeader>
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault()
          void mutation
            .run(() =>
              initial
                ? tracerApi.humanScores.updateCollection(
                    initial.id,
                    initial.revision,
                    { name, description, scoreIds }
                  )
                : tracerApi.humanScores.createCollection({
                    name,
                    description,
                    scoreIds,
                  })
            )
            .then(onSaved)
            .catch(() => {})
        }}
      >
        <fieldset disabled={mutation.isPending} className="space-y-4">
          <label className="grid gap-1.5 text-sm">
            Name
            <Input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            Description
            <Textarea
              autoSize
              rows={2}
              maxLength={4000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <ComboboxMultiple
            label="Human Scores"
            icon={<ListChecks />}
            placeholder="Select Human Scores…"
            options={library.scores.map((score) => ({
              value: score.id,
              label: score.name,
              description: humanScoreTypeLabel(score),
              icon: humanScoreIcon(score),
            }))}
            value={scoreIds}
            onValueChange={setScoreIds}
            maxSelected={30}
          />
          {scoreIds.length > 0 && (
            <ol className="space-y-1 text-sm text-foreground-muted">
              {scoreIds.map((id, index) => (
                <li key={id}>
                  {index + 1}.{" "}
                  {library.scores.find((score) => score.id === id)?.name}
                </li>
              ))}
            </ol>
          )}
          {mutation.error && (
            <Notice variant="error">{mutation.error.message}</Notice>
          )}
          <Button
            type="submit"
            disabled={mutation.isPending || scoreIds.length === 0}
          >
            {mutation.isPending
              ? "Saving…"
              : initial
                ? "Save changes"
                : "Create collection"}
          </Button>
        </fieldset>
      </form>
    </DialogContent>
  )
}

export function HumanCollectionSelect({
  value,
  onChange,
  disabled,
}: {
  value: string | null
  onChange: (id: string | null) => void
  disabled?: boolean
}) {
  const library = useRemote(tracerApi.humanScores.library, [])
  if (!library.data)
    return library.error ? (
      <ErrorState error={library.error} onRetry={library.refresh} />
    ) : (
      <LoadingState label="Loading Human Score collections" />
    )
  return (
    <div className="space-y-1.5">
      <p className="text-sm">Human Score collection</p>
      <Combobox
        label="Human Score collection"
        icon={<Layers />}
        value={value ?? ""}
        onValueChange={(id) => onChange(id || null)}
        disabled={disabled}
        options={[
          { value: "", label: "No collection" },
          ...library.data.collections.map((collection) => ({
            value: collection.id,
            label: collection.name,
            description: `${collection.scoreIds.length} Human Scores`,
          })),
        ]}
      />
      {library.error && (
        <ErrorState error={library.error} onRetry={library.refresh} />
      )}
    </div>
  )
}
