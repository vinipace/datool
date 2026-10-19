"use client"

import * as React from "react"
import {
  ArrowRight,
  Bot,
  Check,
  ChevronRight,
  Clock3,
  FileDiff,
  History,
  MessageSquare,
  Play,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import { FormRow } from "@/components/ui/form-row"
import { InspectorSection } from "@/components/ui/inspector-section"
import { LoadingState } from "@/components/ui/loading-state"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useRemote } from "@/components/tracer/hooks"
import {
  buildCall,
  buildOperations,
  formatBuildError,
  listItems,
} from "@/components/build/shared/build-api"
import type {
  ActionRecord,
  ProcedureRecord,
  WidgetRecord,
} from "@/src/lib/build/contracts"
import type {
  CopilotProposalRecord,
  CopilotTargetKind,
} from "@/src/lib/build/testing"

type CopilotAuditRecord = {
  id: string
  proposalId: string
  event: string
  actorId: string | null
  payload: unknown
  createdAt: string
}

type TargetKind = CopilotTargetKind

const targetKinds: Array<{ value: TargetKind; label: string }> = [
  { value: "instructions", label: "Agent instructions" },
  { value: "action", label: "Action" },
  { value: "procedure", label: "Procedure" },
  { value: "widget", label: "Widget" },
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function jsonText(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2)
  } catch {
    return "null"
  }
}

function formatDate(value: string) {
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date)
}

function targetLabel(kind: TargetKind) {
  return targetKinds.find((item) => item.value === kind)?.label ?? kind
}

function proposalStatusLabel(status: CopilotProposalRecord["status"]) {
  return status.charAt(0).toUpperCase() + status.slice(1)
}

function proposalTone(status: CopilotProposalRecord["status"]) {
  if (status === "applied") return "text-success"
  if (status === "approved") return "text-info-foreground"
  if (status === "rejected" || status === "expired") return "text-destructive"
  return "text-warning-foreground"
}

function ProposalStatus({
  status,
}: {
  status: CopilotProposalRecord["status"]
}) {
  const tone = proposalTone(status)
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs ${tone}`}>
      <span
        aria-hidden
        className={`size-1.5 rounded-full ${tone.replace("text-", "bg-")}`}
      />
      {proposalStatusLabel(status)}
    </span>
  )
}

function sourceValue(proposal: CopilotProposalRecord) {
  if (isRecord(proposal.sourceSnapshot) && "value" in proposal.sourceSnapshot)
    return proposal.sourceSnapshot.value
  return proposal.sourceSnapshot
}

function countChanges(value: unknown): number {
  if (!isRecord(value)) return 0
  if (typeof value.kind === "string" && value.kind !== "unchanged") {
    const nested = Array.isArray(value.changes)
      ? value.changes.reduce((total, child) => total + countChanges(child), 0)
      : 0
    return Math.max(1, nested)
  }
  if (Array.isArray(value.changes))
    return value.changes.reduce(
      (total, child) => total + countChanges(child),
      0
    )
  return Object.values(value).reduce<number>(
    (total, child) => total + countChanges(child),
    0
  )
}

function ProposalDiff({ proposal }: { proposal: CopilotProposalRecord }) {
  const source = sourceValue(proposal)
  const changes = countChanges(proposal.diff)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
        <FileDiff className="size-3.5" aria-hidden />
        <span>
          {changes} change{changes === 1 ? "" : "s"} proposed
        </span>
        <span aria-hidden>·</span>
        <span>Base revision {proposal.baseRevision}</span>
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <InspectorSection label="Current value" defaultOpen>
          <CodeEditor
            value={jsonText(source)}
            language="json"
            label="Current value"
            readOnly
            onChange={() => {}}
            className="min-h-56"
          />
        </InspectorSection>
        <InspectorSection label="Proposed value" defaultOpen>
          <CodeEditor
            value={jsonText(proposal.proposedValue)}
            language="json"
            label="Proposed value"
            readOnly
            onChange={() => {}}
            className="min-h-56"
          />
        </InspectorSection>
      </div>
      <InspectorSection
        label="Technical diff"
        icon={<FileDiff className="size-3.5" />}
        defaultOpen={false}
      >
        <CodeEditor
          value={jsonText(proposal.diff)}
          language="json"
          label="Structured proposal diff"
          readOnly
          onChange={() => {}}
          className="min-h-48"
        />
      </InspectorSection>
    </div>
  )
}

export function CopilotTab({
  agentId,
  onDefinitionDirty,
}: {
  agentId: string
  onDefinitionDirty?: () => void
}) {
  const proposalsState = useRemote(
    React.useCallback(
      (signal: AbortSignal) =>
        buildCall<unknown>(
          buildOperations.listCopilotProposals,
          { agentId },
          { signal }
        ).then((value) => listItems<CopilotProposalRecord>(value)),
      [agentId]
    ),
    [agentId]
  )
  const targetsState = useRemote(
    React.useCallback(
      async (signal: AbortSignal) => {
        const [actions, procedures, widgets] = await Promise.all([
          buildCall<unknown>(
            buildOperations.listActions,
            { agentId },
            { signal }
          ),
          buildCall<unknown>(
            buildOperations.listProcedures,
            { agentId },
            { signal }
          ),
          buildCall<unknown>(
            buildOperations.listWidgets,
            { agentId },
            { signal }
          ),
        ])
        return {
          actions: listItems<ActionRecord>(actions),
          procedures: listItems<ProcedureRecord>(procedures),
          widgets: listItems<WidgetRecord>(widgets),
        }
      },
      [agentId]
    ),
    [agentId]
  )
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const [targetKind, setTargetKind] = React.useState<TargetKind>("instructions")
  const [targetId, setTargetId] = React.useState("")
  const [request, setRequest] = React.useState("")
  const [mutation, setMutation] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const proposals = proposalsState.data ?? []
  const activeProposalId =
    selectedId && proposals.some((proposal) => proposal.id === selectedId)
      ? selectedId
      : (proposals[0]?.id ?? null)

  const selectedState = useRemote(
    React.useCallback(
      (signal: AbortSignal) =>
        buildCall<CopilotProposalRecord>(
          buildOperations.getCopilotProposal,
          { proposalId: activeProposalId ?? "" },
          { signal }
        ),
      [activeProposalId]
    ),
    [activeProposalId],
    { enabled: Boolean(activeProposalId) }
  )
  const auditEnabled = Boolean(activeProposalId && selectedState.data)
  const targetAudit = useRemote(
    React.useCallback(
      (signal: AbortSignal) =>
        buildCall<unknown>(
          buildOperations.listCopilotAudit,
          { proposalId: activeProposalId ?? "" },
          { signal }
        ).then((value) => listItems<CopilotAuditRecord>(value)),
      [activeProposalId]
    ),
    [activeProposalId],
    { enabled: auditEnabled }
  )

  const targetOptions = React.useMemo(() => {
    if (!targetsState.data) return []
    if (targetKind === "action")
      return targetsState.data.actions.map((item) => ({
        id: item.id,
        label: item.definition.name,
      }))
    if (targetKind === "procedure")
      return targetsState.data.procedures.map((item) => ({
        id: item.id,
        label: item.definition.name,
      }))
    if (targetKind === "widget")
      return targetsState.data.widgets.map((item) => ({
        id: item.id,
        label: item.definition.name,
      }))
    return []
  }, [targetKind, targetsState.data])

  async function createProposal(event: React.FormEvent) {
    event.preventDefault()
    if (
      !request.trim() ||
      (targetKind !== "instructions" && !targetId) ||
      mutation
    )
      return
    setMutation("Creating proposal")
    setError(null)
    try {
      const proposal = await buildCall<CopilotProposalRecord>(
        buildOperations.createCopilotProposal,
        {
          agentId,
          targetKind,
          targetId: targetKind === "instructions" ? null : targetId,
          request: request.trim(),
        }
      )
      setRequest("")
      setSelectedId(proposal.id)
      proposalsState.refresh()
      setMutation(null)
    } catch (reason) {
      setError(formatBuildError(reason))
      setMutation(null)
    }
  }

  async function transition(
    operation: string,
    proposal: CopilotProposalRecord,
    label: string,
    confirmMessage?: string
  ) {
    if (mutation) return
    if (confirmMessage && !window.confirm(confirmMessage)) return
    setMutation(label)
    setError(null)
    try {
      await buildCall(operation, {
        proposalId: proposal.id,
        ...(operation === buildOperations.applyCopilotProposal
          ? { expectedRevision: proposal.baseRevision }
          : {}),
      })
      if (
        operation === buildOperations.applyCopilotProposal &&
        proposal.targetKind !== "instructions"
      )
        onDefinitionDirty?.()
      proposalsState.refresh()
      selectedState.refresh()
      targetAudit.refresh()
      setMutation(null)
    } catch (reason) {
      setError(formatBuildError(reason))
      setMutation(null)
    }
  }

  const selected = selectedState.data
  const canCreate =
    request.trim().length > 0 &&
    (targetKind === "instructions" || Boolean(targetId))

  return (
    <div className="mx-auto w-full max-w-4xl space-y-6 px-4 py-6 sm:px-6">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-muted text-foreground">
          <Sparkles className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium tracking-wide text-foreground-muted uppercase">
            Build assistant
          </p>
          <h2 className="mt-1 text-lg font-semibold tracking-tight">Copilot</h2>
          <p className="mt-1 max-w-2xl text-sm text-foreground-muted">
            Describe the change you want to explore. Copilot drafts a proposal
            for you to review, approve, and apply when it is ready.
          </p>
        </div>
      </header>
      <Notice variant="info" className="flex items-start gap-2">
        <ShieldCheck className="mt-0.5 size-4 shrink-0" aria-hidden />
        <div>
          <p className="font-medium">You stay in control</p>
          <p className="mt-1">
            Drafting never changes the agent. Approval and apply are separate
            steps, and apply checks that the target revision is still current.
          </p>
        </div>
      </Notice>
      {error ? (
        <Notice role="alert" variant="error">
          {error}
        </Notice>
      ) : null}
      <section className="rounded-xl border border-border bg-muted p-4 sm:p-5">
        <div className="flex items-start gap-3">
          <span className="grid size-8 shrink-0 place-items-center rounded-full bg-background text-foreground-muted">
            <Bot className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <h3 className="text-sm font-semibold">What should we improve?</h3>
              <span className="text-xs text-foreground-muted">Copilot</span>
            </div>
            <p className="mt-1 text-sm text-foreground-muted">
              Choose the part of this agent you want to change, then explain the
              outcome you want. I will return a reviewable proposal.
            </p>
            {targetsState.error ? (
              <Notice role="alert" variant="error" className="mt-4">
                Unable to load action, procedure and widget targets:{" "}
                {targetsState.error.message}
              </Notice>
            ) : null}
            <form
              onSubmit={(event) => void createProposal(event)}
              className="mt-4 space-y-4"
            >
              <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                <FormRow
                  layout="vertical"
                  label="What are you changing?"
                  htmlFor="copilot-target-kind"
                >
                  <Select
                    id="copilot-target-kind"
                    value={targetKind}
                    onChange={(event) => {
                      setTargetKind(event.target.value as TargetKind)
                      setTargetId("")
                    }}
                  >
                    {targetKinds.map((item) => (
                      <option key={item.value} value={item.value}>
                        {item.label}
                      </option>
                    ))}
                  </Select>
                </FormRow>
                {targetKind !== "instructions" ? (
                  <FormRow
                    layout="vertical"
                    label={`Which ${targetLabel(targetKind).toLowerCase()}?`}
                    htmlFor="copilot-target-id"
                  >
                    <Select
                      id="copilot-target-id"
                      value={targetId}
                      disabled={targetsState.isLoading || !targetOptions.length}
                      onChange={(event) => setTargetId(event.target.value)}
                    >
                      <option value="">
                        {targetsState.isLoading
                          ? "Loading targets…"
                          : targetOptions.length
                            ? "Choose a target"
                            : `No ${targetKind}s yet`}
                      </option>
                      {targetOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {option.label}
                        </option>
                      ))}
                    </Select>
                  </FormRow>
                ) : null}
              </div>
              <div>
                <label
                  htmlFor="copilot-request"
                  className="mb-2 block text-sm font-medium"
                >
                  Tell me what you want to change
                </label>
                <Textarea
                  id="copilot-request"
                  aria-label="Copilot request"
                  rows={4}
                  autoSize
                  maxLength={16_000}
                  value={request}
                  placeholder="For example: make the assistant ask for an order number before looking up delivery status…"
                  onChange={(event) => setRequest(event.target.value)}
                />
                <p className="mt-2 text-xs text-foreground-muted">
                  Be specific about behavior, tone and constraints. Credentials
                  and secrets are not sent as part of this request.
                </p>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-foreground-muted">
                  You will review the proposal before anything is applied.
                </span>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canCreate || Boolean(mutation)}
                  loading={mutation === "Creating proposal"}
                >
                  <Sparkles className="size-3.5" />
                  Create reviewable proposal
                </Button>
              </div>
            </form>
          </div>
        </div>
      </section>
      <div className="flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-foreground">
          <MessageSquare className="size-3.5" aria-hidden />
          1. Describe
        </span>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1">
          2. Review the proposal
        </span>
        <ChevronRight className="size-3.5" aria-hidden />
        <span className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1">
          3. Approve and apply
        </span>
      </div>
      <section aria-label="Proposal review" className="min-w-0 space-y-4">
        {activeProposalId && selectedState.error ? (
          <Notice role="alert" variant="error">
            {selectedState.error.message}
          </Notice>
        ) : !activeProposalId || selectedState.data === null ? (
          <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-border px-6 text-center text-sm text-foreground-muted">
            Your next proposal will appear here with the exact changes, review
            controls, and audit history.
          </div>
        ) : selected ? (
          <>
            <div className="rounded-xl border border-border bg-background px-4 py-4 sm:px-5">
              <div className="mb-4 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <FileDiff
                    className="size-4 text-foreground-muted"
                    aria-hidden
                  />
                  Review proposal
                </div>
                <ProposalStatus status={selected.status} />
              </div>
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs tracking-wide text-foreground-muted uppercase">
                    {targetLabel(selected.targetKind)}
                  </p>
                  <p className="mt-1 text-sm font-medium break-words">
                    {selected.targetId ?? "Agent instructions"}
                  </p>
                  <p className="mt-2 max-w-3xl text-sm whitespace-pre-wrap text-foreground-muted">
                    {selected.request}
                  </p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-2 text-xs text-foreground-muted">
                <span>Created {formatDate(selected.createdAt)}</span>
                <span aria-hidden>·</span>
                <span>Base revision {selected.baseRevision}</span>
                {selected.createdBy ? (
                  <>
                    <span aria-hidden>·</span>
                    <span>By {selected.createdBy}</span>
                  </>
                ) : null}
              </div>
              <p className="mt-3 flex items-start gap-2 text-xs text-foreground-muted">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                Applying this proposal rechecks revision {selected.baseRevision}
                before changing the agent.
              </p>
              <div className="mt-4 flex flex-wrap items-center gap-2">
                {selected.status === "proposed" ? (
                  <>
                    <Button
                      type="button"
                      size="sm"
                      disabled={Boolean(mutation)}
                      loading={mutation === "Approving proposal"}
                      onClick={() =>
                        void transition(
                          buildOperations.approveCopilotProposal,
                          selected,
                          "Approving proposal"
                        )
                      }
                    >
                      <Check className="size-3.5" />
                      Approve
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={Boolean(mutation)}
                      loading={mutation === "Rejecting proposal"}
                      onClick={() =>
                        void transition(
                          buildOperations.rejectCopilotProposal,
                          selected,
                          "Rejecting proposal",
                          "Reject this proposal? It will remain in the audit history and cannot be applied."
                        )
                      }
                    >
                      <X className="size-3.5" />
                      Reject
                    </Button>
                  </>
                ) : null}
                {selected.status === "approved" ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={Boolean(mutation)}
                    loading={mutation === "Applying proposal"}
                    onClick={() =>
                      void transition(
                        buildOperations.applyCopilotProposal,
                        selected,
                        "Applying proposal",
                        "Apply this approved proposal to the agent? Build will reject it if the base revision changed."
                      )
                    }
                  >
                    <Play className="size-3.5" />
                    Apply to agent
                  </Button>
                ) : null}
                {selected.status === "expired" ? (
                  <Notice variant="warning" className="px-2 py-1 text-xs">
                    The target changed after this proposal was generated. Create
                    a fresh proposal.
                  </Notice>
                ) : null}
                {selected.status === "applied" ? (
                  <Notice variant="success" className="px-2 py-1 text-xs">
                    Applied at{" "}
                    {formatDate(selected.appliedAt ?? selected.createdAt)}.
                  </Notice>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={Boolean(mutation)}
                  onClick={() => {
                    selectedState.refresh()
                    targetAudit.refresh()
                  }}
                >
                  <RefreshCw className="size-3.5" />
                  Refresh
                </Button>
              </div>
            </div>
            <InspectorSection
              label="Changes to review"
              icon={<FileDiff className="size-3.5" />}
            >
              <ProposalDiff proposal={selected} />
            </InspectorSection>
            <InspectorSection
              label="Audit trail"
              icon={<History className="size-3.5" />}
              defaultOpen={false}
            >
              {targetAudit.error ? (
                <Notice role="alert" variant="error">
                  {targetAudit.error.message}
                </Notice>
              ) : targetAudit.data === null ? (
                <LoadingState compact label="Loading audit trail" />
              ) : !targetAudit.data.length ? (
                <p className="text-sm text-foreground-muted">
                  No audit events yet.
                </p>
              ) : (
                <div className="divide-y divide-border rounded-md border border-border">
                  {targetAudit.data.map((event) => (
                    <details key={event.id} className="group/audit px-3 py-3">
                      <summary className="flex cursor-pointer list-none items-center gap-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                        <Clock3
                          className="size-3.5 text-foreground-muted"
                          aria-hidden
                        />
                        <span className="font-medium">{event.event}</span>
                        <span className="ml-auto text-xs text-foreground-muted">
                          {formatDate(event.createdAt)}
                        </span>
                      </summary>
                      <div className="mt-3 space-y-2 pl-6 text-xs text-foreground-muted">
                        <p>Actor: {event.actorId ?? "system"}</p>
                        <CodeEditor
                          value={jsonText(event.payload)}
                          language="json"
                          label={`${event.event} audit payload`}
                          readOnly
                          onChange={() => {}}
                          className="min-h-24"
                        />
                      </div>
                    </details>
                  ))}
                </div>
              )}
            </InspectorSection>
          </>
        ) : null}
      </section>
      <InspectorSection
        label="Earlier proposals"
        icon={<History className="size-3.5" />}
        defaultOpen={false}
      >
        {proposalsState.error ? (
          <Notice role="alert" variant="error">
            {proposalsState.error.message}
          </Notice>
        ) : proposalsState.data === null ? (
          <LoadingState compact label="Loading proposals" />
        ) : !proposals.length ? (
          <div className="space-y-2 text-sm text-foreground-muted">
            <p>No proposals yet.</p>
            <p>Generated proposals will stay available here for review.</p>
          </div>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {proposals.map((proposal) => (
              <button
                key={proposal.id}
                type="button"
                aria-pressed={activeProposalId === proposal.id}
                className={`flex w-full items-start gap-3 px-3 py-3 text-left transition-colors outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring ${activeProposalId === proposal.id ? "bg-muted" : ""}`}
                onClick={() => setSelectedId(proposal.id)}
              >
                <FileDiff
                  className="mt-0.5 size-3.5 shrink-0 text-foreground-muted"
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {targetLabel(proposal.targetKind)}
                    {proposal.targetId ? ` · ${proposal.targetId}` : ""}
                  </span>
                  <span className="mt-1 block truncate text-xs text-foreground-muted">
                    {proposal.request}
                  </span>
                  <span className="mt-2 flex flex-wrap items-center gap-2">
                    <ProposalStatus status={proposal.status} />
                    <span className="text-xs text-foreground-muted">
                      {formatDate(proposal.createdAt)}
                    </span>
                  </span>
                </span>
                <ArrowRight
                  className="mt-1 size-3.5 shrink-0 text-foreground-muted"
                  aria-hidden
                />
              </button>
            ))}
          </div>
        )}
      </InspectorSection>
      {selectedState.isRefreshing || proposalsState.isRefreshing ? (
        <p
          className="flex items-center gap-2 text-xs text-foreground-muted"
          role="status"
        >
          <RotateCcw className="size-3.5 animate-spin" aria-hidden />
          Refreshing proposal state…
        </p>
      ) : null}
    </div>
  )
}
