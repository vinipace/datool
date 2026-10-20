"use client"

import { useState, type FormEvent } from "react"
import { Save, Trash2, Zap } from "lucide-react"
import { useRemote } from "@/components/tracer/hooks"
import { Button } from "@/components/ui/button"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { RichTextEditor } from "@/components/ui/rich-text-editor"
import { BuildErrorState } from "../shared/build-layout"
import {
  buildCall,
  buildOperations,
  formatBuildError,
  listItems,
} from "../shared/build-api"
import {
  procedureDefinitionSchema,
  type ActionRecord,
  type ProcedureDefinition,
  type ProcedureRecord,
} from "@/src/lib/build/contracts"
import { StructuredSkillSteps } from "./structured-skill-steps"

export function SkillEditor({
  agentId,
  record,
  initial,
  suggestedActions,
  onClose,
  onSaved,
}: {
  agentId: string
  record?: ProcedureRecord
  initial: ProcedureDefinition
  suggestedActions?: string[]
  onClose: () => void
  onSaved: (deleted?: boolean) => void
}) {
  const [draft, setDraft] = useState(initial)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [invalidJson, setInvalidJson] = useState<Record<string, boolean>>({})
  const actions = useRemote(
    (signal) =>
      buildCall<unknown>(
        buildOperations.listActions,
        { agentId },
        { signal }
      ).then(listItems<ActionRecord>),
    [agentId]
  )
  const structured = Boolean(initial.steps.length)
  const dirty =
    JSON.stringify(draft) !== JSON.stringify(initial) ||
    Object.values(invalidJson).some(Boolean)
  const update = <K extends keyof ProcedureDefinition>(
    key: K,
    value: ProcedureDefinition[K]
  ) => setDraft((current) => ({ ...current, [key]: value }))
  const available = actions.data ?? []

  function close() {
    if (pending) return
    if (dirty && !window.confirm("Discard unsaved skill changes?")) return
    onClose()
  }
  async function save(event: FormEvent) {
    event.preventDefault()
    if (pending) return
    if (Object.values(invalidJson).some(Boolean)) {
      setError("Correct the invalid JSON before saving.")
      return
    }
    const parsed = procedureDefinitionSchema.safeParse({
      ...draft,
      name: draft.name.trim(),
      trigger: { ...draft.trigger, value: draft.trigger.value.trim() },
    })
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the skill fields.")
      return
    }
    setPending(true)
    setError(null)
    try {
      await buildCall(buildOperations.updateProcedure, {
        agentId,
        ...(record
          ? {
              id: record.id,
              slug: record.slug,
              expectedRevision: record.revision,
            }
          : {}),
        definition: parsed.data,
      })
      onSaved()
      onClose()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  async function remove() {
    if (
      !record ||
      pending ||
      !window.confirm(`Delete ${record.definition.name}?`)
    )
      return
    setPending(true)
    setError(null)
    try {
      await buildCall(buildOperations.deleteProcedure, {
        agentId,
        procedureId: record.id,
        expectedRevision: record.revision,
      })
      onSaved(true)
      onClose()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) close()
      }}
    >
      <SheetContent>
        <SheetHeader className="shrink-0 border-b border-border p-5">
          <SheetTitle>{record ? "Edit skill" : "New skill"}</SheetTitle>
          <SheetDescription>
            Teach your agent when and how to handle a specific task.
          </SheetDescription>
        </SheetHeader>
        <form
          onSubmit={(event) => void save(event)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 overflow-auto p-5">
            {error ? (
              <Notice variant="error" role="alert" className="mb-5">
                {error}
              </Notice>
            ) : null}
            <fieldset disabled={pending} className="min-w-0 space-y-5">
              {suggestedActions ? (
                <Notice variant="info">
                  This template starts disabled. Review the instructions and
                  your policies, then link the actions it should use. Suggested
                  actions: {suggestedActions.join(", ")}.
                </Notice>
              ) : null}
              <FormRow
                layout="vertical"
                variant="plain"
                label="Name"
                htmlFor="skill-name"
              >
                <Input
                  id="skill-name"
                  required
                  maxLength={160}
                  placeholder="e.g. Order refund"
                  value={draft.name}
                  onChange={(event) => update("name", event.target.value)}
                />
              </FormRow>
              <FormRow
                layout="vertical"
                variant="plain"
                label="Description"
                htmlFor="skill-description"
              >
                <Textarea
                  id="skill-description"
                  rows={2}
                  maxLength={2000}
                  placeholder="A short summary of what this skill helps with."
                  value={draft.description}
                  onChange={(event) =>
                    update("description", event.target.value)
                  }
                />
              </FormRow>
              <FormRow
                layout="vertical"
                variant="plain"
                label="Activation"
                htmlFor="skill-activation"
              >
                <Select
                  id="skill-activation"
                  value={draft.trigger.type}
                  onChange={(event) =>
                    update("trigger", {
                      ...draft.trigger,
                      type: event.target
                        .value as ProcedureDefinition["trigger"]["type"],
                    })
                  }
                >
                  <option value="intent">Agent chooses when relevant</option>
                  <option value="keyword">Keyword match</option>
                  <option value="event">Trusted event</option>
                  <option value="manual">Run manually</option>
                </Select>
              </FormRow>
              <FormRow
                layout="vertical"
                variant="plain"
                label={
                  draft.trigger.type === "intent"
                    ? "When to use"
                    : draft.trigger.type === "keyword"
                      ? "Keyword"
                      : draft.trigger.type === "event"
                        ? "Event name"
                        : "Manual trigger name"
                }
                htmlFor="skill-trigger"
                description={
                  draft.trigger.type === "intent"
                    ? "Describe the customer's request. The agent uses this to select the skill."
                    : draft.trigger.type === "event"
                      ? "Matches an event provided by an authenticated channel adapter."
                      : undefined
                }
              >
                <Textarea
                  id="skill-trigger"
                  required
                  rows={2}
                  maxLength={500}
                  placeholder="Use when the customer…"
                  value={draft.trigger.value}
                  onChange={(event) =>
                    update("trigger", {
                      ...draft.trigger,
                      value: event.target.value,
                    })
                  }
                />
              </FormRow>
              {structured ? (
                <>
                  <Notice variant="info">
                    This existing skill uses structured steps. Its execution and
                    continuations are preserved.
                  </Notice>
                  <StructuredSkillSteps
                    steps={draft.steps}
                    onChange={(steps) => update("steps", steps)}
                  />
                  {(["variables", "branches"] as const).map((key) => (
                    <SkillJsonField
                      key={key}
                      name={key}
                      value={initial[key]}
                      onChange={(value) => update(key, value as never)}
                      onValid={(valid) =>
                        setInvalidJson((current) => ({
                          ...current,
                          [key]: !valid,
                        }))
                      }
                    />
                  ))}
                </>
              ) : (
                <FormRow
                  layout="vertical"
                  variant="plain"
                  label="Instructions"
                  htmlFor="skill-instructions"
                  description="Type @ to mention an action and link it automatically. Write steps, conditions and fallback instructions using Markdown."
                >
                  <RichTextEditor
                    id="skill-instructions"
                    label="Instructions"
                    variant="field"
                    disabled={pending}
                    maxLength={32000}
                    placeholder="Write the steps your agent should follow. Type @ to mention an action…"
                    value={draft.instructions ?? ""}
                    onChange={(value) => update("instructions", value)}
                    mentions={available.map((action) => ({
                      value: action.slug,
                      label: action.definition.name,
                      description: !action.definition.enabled
                        ? "Disabled action"
                        : action.definition.description,
                      keywords: [action.slug],
                      disabled: !action.definition.enabled,
                      icon: Zap,
                    }))}
                    mentionEmptyLabel={
                      actions.data === null
                        ? "Loading actions…"
                        : available.length
                          ? "No matching actions."
                          : "No actions yet. Add one on the Actions page."
                    }
                  />
                  {actions.error ? (
                    <BuildErrorState
                      message={actions.error.message}
                      onRetry={actions.refresh}
                    />
                  ) : null}
                </FormRow>
              )}
              <FormRow
                label="Enabled"
                htmlFor="skill-enabled"
                controlWidth="auto"
                description="Allow the agent to use this skill when its trigger matches."
              >
                <Switch
                  id="skill-enabled"
                  checked={draft.enabled}
                  onCheckedChange={(value) => update("enabled", value)}
                />
              </FormRow>
            </fieldset>
          </div>
          <SheetFooter className="shrink-0 border-t border-border p-5">
            {record ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => void remove()}
                className="sm:mr-auto"
              >
                <Trash2 />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={close}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" loading={pending}>
              <Save />
              {record ? "Save skill" : "Create skill"}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}

function SkillJsonField({
  name,
  value,
  onChange,
  onValid,
}: {
  name: "variables" | "branches"
  value: unknown
  onChange: (value: unknown) => void
  onValid: (valid: boolean) => void
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2))
  const [invalid, setInvalid] = useState(false)
  return (
    <FormRow
      layout="vertical"
      variant="plain"
      label={`${name === "variables" ? "Variables" : "Branches"} (JSON)`}
      htmlFor={`skill-${name}`}
    >
      <Textarea
        id={`skill-${name}`}
        rows={4}
        value={text}
        spellCheck={false}
        aria-invalid={invalid || undefined}
        onChange={(event) => {
          setText(event.target.value)
          try {
            const parsed: unknown = JSON.parse(event.target.value)
            const valid =
              name === "branches"
                ? Array.isArray(parsed)
                : parsed !== null &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed)
            setInvalid(!valid)
            onValid(valid)
            if (valid) onChange(parsed)
          } catch {
            setInvalid(true)
            onValid(false)
          }
        }}
      />
      {invalid ? (
        <p className="mt-1 text-xs text-destructive">
          Enter a valid JSON {name === "branches" ? "array" : "object"}.
        </p>
      ) : null}
    </FormRow>
  )
}
