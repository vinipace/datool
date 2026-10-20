"use client"

import * as React from "react"
import { Megaphone, Play, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useMutation, useRemote } from "@/components/tracer/hooks"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { OPERATIONS_CHANNEL_CAPABILITIES } from "@/src/lib/build/contracts"
import { buildApi, asList, asRecord } from "./build-api"
import {
  BuildCell,
  BuildEmpty,
  BuildFormCard,
  BuildFrame,
  BuildRow,
  BuildState,
  BuildStatus,
  BuildTable,
  BuildToolbar,
  FormLabel,
} from "./build-page"
import { useWideViewport } from "./use-wide-viewport"

type Campaign = {
  id: string
  name: string
  channel?: string
  connectionId?: string | null
  status?: string
  scheduledAt?: string | null
  updatedAt?: string
  audienceCount?: number
  deliveredCount?: number
  repliedCount?: number
  template?: Record<string, unknown>
  audienceFilter?: Record<string, unknown>
  suppressionFilter?: Record<string, unknown>
}
type ChannelConnection = {
  id: string
  channel?: string
  label?: string
  status?: string
  externalId?: string | null
}
type Delivery = {
  id: string
  audienceId?: string
  state?: string
  attemptCount?: number
  providerMessageId?: string | null
  lastError?: string | null
  updatedAt?: string
}
type CampaignForm = {
  name: string
  channel: string
  connectionId: string
  message: string
  template: string
  advancedTemplate: boolean
  audience: string
  suppression: string
  scheduledAt: string
}

const initialForm: CampaignForm = {
  name: "",
  channel: "telegram",
  connectionId: "",
  message: "",
  template: '{"text":""}',
  advancedTemplate: false,
  audience: "{}",
  suppression: "{}",
  scheduledAt: "",
}

const campaignChannels = Object.entries(OPERATIONS_CHANNEL_CAPABILITIES)
  .filter(([, capability]) => capability.campaigns && capability.outbound)
  .map(([value]) => ({
    value,
    label: value === "telegram" ? "Telegram" : value,
  }))

function campaignList(value: unknown) {
  const record = asRecord(value)
  return asList<Campaign>(record.items ?? value)
}

function connectionList(value: unknown) {
  const record = asRecord(value)
  return asList<ChannelConnection>(record.items ?? record.channels ?? value)
}

function deliveryList(value: unknown) {
  const record = asRecord(value)
  return asList<Delivery>(record.items ?? value)
}

function formatDate(value?: string | null) {
  if (!value) return "Immediately"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString()
}

function parseObject(value: string, label: string) {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw new Error(`${label} must be a JSON object.`)
    return parsed as Record<string, unknown>
  } catch (error) {
    throw error instanceof Error
      ? error
      : new Error(`${label} must be valid JSON.`)
  }
}

function messagePreview(value?: Record<string, unknown>) {
  if (!value) return "Add a message template to preview it here."
  const candidate = [value.text, value.body, value.message].find(
    (item) => typeof item === "string" && item.trim()
  )
  if (typeof candidate === "string") return candidate
  return "This campaign uses a structured message template."
}

export function CampaignsPage() {
  const workspaceHref = useWorkspaceHref()
  const isWide = useWideViewport()
  const [status, setStatus] = React.useState("")
  const [search, setSearch] = React.useState("")
  const [showCreate, setShowCreate] = React.useState(false)
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const campaigns = useRemote(
    (signal) =>
      buildApi
        .call<unknown>(
          "build_list_campaigns",
          {
            limit: 100,
            status: status || undefined,
            search: search || undefined,
          },
          signal
        )
        .then(campaignList),
    [status, search],
    { intervalMs: 15_000 }
  )
  const connections = useRemote(
    (signal) =>
      buildApi
        .call<unknown>("build_list_channels", {}, signal)
        .then(connectionList),
    [],
    { intervalMs: 30_000 }
  )
  const selectedCampaign =
    campaigns.data?.find((campaign) => campaign.id === selectedId) ?? null
  const deliveries = useRemote(
    (signal) =>
      selectedId
        ? buildApi
            .call<unknown>(
              "build_list_campaign_deliveries",
              { campaignId: selectedId, limit: 100 },
              signal
            )
            .then(deliveryList)
        : Promise.resolve([]),
    [selectedId],
    { enabled: !!selectedId, intervalMs: 5_000 }
  )
  const create = useMutation()
  const run = useMutation()
  const [form, setForm] = React.useState<CampaignForm>(initialForm)
  const [formError, setFormError] = React.useState<string | null>(null)

  function openCreate() {
    setForm(initialForm)
    setFormError(null)
    setShowCreate(true)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!form.name.trim()) {
      setFormError("Give this campaign a name.")
      return
    }
    let template: Record<string, unknown>
    let audienceFilter: Record<string, unknown>
    let suppressionFilter: Record<string, unknown>
    if (form.advancedTemplate) {
      try {
        template = parseObject(form.template, "Structured message")
      } catch (error) {
        setFormError(
          error instanceof Error
            ? error.message
            : "Structured message must be valid JSON."
        )
        return
      }
      const structuredMessage = [
        template.text,
        template.body,
        template.message,
      ].find((value) => typeof value === "string" && value.trim())
      if (typeof structuredMessage !== "string") {
        setFormError(
          "Structured message must include a non-empty text, body or message field."
        )
        return
      }
    } else {
      if (!form.message.trim()) {
        setFormError("Write a message before creating the campaign.")
        return
      }
      template = { text: form.message.trim() }
    }
    try {
      audienceFilter = parseObject(form.audience, "Audience rules")
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Audience rules must be valid JSON."
      )
      return
    }
    try {
      suppressionFilter = parseObject(form.suppression, "Exclusion rules")
    } catch (error) {
      setFormError(
        error instanceof Error
          ? error.message
          : "Exclusion rules must be valid JSON."
      )
      return
    }
    setFormError(null)
    const result = await create.run(() =>
      buildApi.call<Campaign>("build_create_campaign", {
        name: form.name.trim(),
        channel: form.channel,
        connectionId: form.connectionId || undefined,
        template,
        audienceFilter,
        suppressionFilter,
        scheduledAt: form.scheduledAt
          ? new Date(form.scheduledAt).toISOString()
          : null,
      })
    )
    setShowCreate(false)
    setForm(initialForm)
    if (result.id) setSelectedId(result.id)
    campaigns.refresh()
  }

  async function execute(campaign: Campaign) {
    await run.run(async () => {
      await buildApi.call("build_snapshot_campaign_audience", {
        campaignId: campaign.id,
      })
      return buildApi.call("build_queue_campaign_deliveries", {
        campaignId: campaign.id,
      })
    })
    campaigns.refresh()
    deliveries.refresh()
  }

  const inspector = (
    <CampaignInspector
      campaign={selectedCampaign}
      deliveries={deliveries.data ?? []}
      loading={deliveries.isLoading}
      error={deliveries.error}
      refresh={deliveries.refresh}
    />
  )
  const connectionOptions =
    connections.data?.filter(
      (connection) => connection.channel === form.channel
    ) ?? []

  return (
    <BuildFrame
      title="Campaigns"
      description="Plan customer outreach with a clear audience, channel and delivery state."
      breadcrumbs={[
        { label: "Build", href: workspaceHref("/build/agents") },
        { label: "Campaigns", href: workspaceHref("/build/campaigns") },
      ]}
      actions={
        <Button size="sm" onClick={openCreate}>
          <Plus className="size-3.5" /> New campaign
        </Button>
      }
    >
      <div className="space-y-4">
        <BuildToolbar
          search={search}
          onSearch={setSearch}
          placeholder="Search campaigns…"
        >
          <span className="hidden text-xs text-foreground-muted sm:inline">
            {campaigns.data?.length ?? 0} campaigns
          </span>
          <Select
            aria-label="Campaign status"
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            className="h-8 w-auto min-w-28 text-xs"
          >
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="scheduled">Scheduled</option>
            <option value="running">Running</option>
            <option value="paused">Paused</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </Select>
        </BuildToolbar>

        <BuildState
          isLoading={campaigns.isLoading}
          error={campaigns.error}
          onRetry={campaigns.refresh}
        >
          {campaigns.data?.length ? (
            <div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(340px,420px)]">
              <section
                className="min-w-0 overflow-hidden rounded-lg border border-border bg-muted"
                aria-label="Campaign list"
              >
                <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div>
                    <h2 className="text-sm font-semibold">Campaigns</h2>
                    <p className="mt-0.5 text-xs text-foreground-muted">
                      Select a campaign to review its delivery progress.
                    </p>
                  </div>
                  <span className="text-xs text-foreground-muted tabular-nums">
                    {campaigns.data.length} shown
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <BuildTable
                    columns={["Campaign", "Status", "Delivery", "Action"]}
                  >
                    {campaigns.data.map((campaign) => (
                      <BuildRow
                        key={campaign.id}
                        selected={campaign.id === selectedId}
                        onClick={() => setSelectedId(campaign.id)}
                      >
                        <BuildCell>
                          <div className="flex items-center gap-2">
                            <span className="grid size-7 place-items-center rounded-full bg-background text-foreground-muted">
                              <Megaphone className="size-3.5" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-medium">
                                {campaign.name}
                              </span>
                              <span className="flex flex-wrap items-center gap-x-1.5 text-xs text-foreground-muted">
                                <span className="capitalize">
                                  {campaign.channel || "—"}
                                </span>
                                <span aria-hidden>·</span>
                                <span>
                                  {campaign.repliedCount ?? 0} replies
                                </span>
                              </span>
                            </span>
                          </div>
                        </BuildCell>
                        <BuildCell>
                          <BuildStatus status={campaign.status} />
                        </BuildCell>
                        <BuildCell>
                          <div className="tabular-nums">
                            {campaign.deliveredCount ?? 0} /{" "}
                            {campaign.audienceCount ?? "—"}
                          </div>
                          <div className="text-xs text-foreground-muted">
                            delivered
                          </div>
                        </BuildCell>
                        <BuildCell className="whitespace-nowrap">
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={
                              !["draft", "scheduled", "paused"].includes(
                                campaign.status ?? ""
                              )
                            }
                            loading={
                              run.isPending && selectedId === campaign.id
                            }
                            onClick={(event) => {
                              event.stopPropagation()
                              void execute(campaign).catch(() => undefined)
                            }}
                          >
                            <Play className="size-3.5" /> Run
                          </Button>
                        </BuildCell>
                      </BuildRow>
                    ))}
                  </BuildTable>
                </div>
              </section>
              {isWide ? <aside className="min-w-0">{inspector}</aside> : null}
            </div>
          ) : (
            <BuildEmpty
              title={
                search || status ? "No matching campaigns" : "No campaigns yet"
              }
              description={
                search || status
                  ? "Try a different name or status."
                  : "Create a campaign to plan a customer message and queue its delivery."
              }
              action={
                <Button onClick={openCreate}>
                  <Plus className="size-3.5" /> Create campaign
                </Button>
              }
            />
          )}
          {run.error ? (
            <Notice className="mt-2" variant="error">
              {run.error.message}
            </Notice>
          ) : null}
        </BuildState>

        {!isWide && selectedCampaign ? (
          <Dialog
            open
            onOpenChange={(open) => {
              if (!open) setSelectedId(null)
            }}
          >
            <DialogContent
              variant="sheet"
              className="max-h-[92dvh] overflow-y-auto px-4"
            >
              <DialogTitle className="sr-only">
                {selectedCampaign.name}
              </DialogTitle>
              <DialogDescription className="sr-only">
                Campaign delivery details
              </DialogDescription>
              {inspector}
            </DialogContent>
          </Dialog>
        ) : null}

        <Dialog
          open={showCreate}
          onOpenChange={(open) => {
            if (!create.isPending) setShowCreate(open)
          }}
        >
          <DialogContent className="max-w-3xl">
            <DialogHeader>
              <DialogTitle>Create campaign</DialogTitle>
              <DialogDescription>
                Choose who should receive the message, where it should go and
                when it should run.
              </DialogDescription>
            </DialogHeader>
            <form
              className="grid gap-5"
              onSubmit={(event) => void submit(event).catch(() => undefined)}
            >
              <div className="grid gap-4 sm:grid-cols-2">
                <FormLabel label="Campaign name">
                  <Input
                    autoFocus
                    value={form.name}
                    onChange={(event) => {
                      setFormError(null)
                      setForm((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }}
                    placeholder="Product announcement"
                  />
                </FormLabel>
                <FormLabel label="Channel">
                  <Select
                    value={form.channel}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        channel: event.target.value,
                        connectionId: "",
                      }))
                    }
                  >
                    {campaignChannels.map((channel) => (
                      <option key={channel.value} value={channel.value}>
                        {channel.label}
                      </option>
                    ))}
                  </Select>
                </FormLabel>
                <FormLabel
                  label="Delivery connection"
                  hint="optional for drafts"
                >
                  <Select
                    value={form.connectionId}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        connectionId: event.target.value,
                      }))
                    }
                  >
                    <option value="">Choose a connection…</option>
                    {connectionOptions.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.label ||
                          connection.externalId ||
                          "Unnamed connection"}
                        {connection.status ? ` · ${connection.status}` : ""}
                      </option>
                    ))}
                  </Select>
                </FormLabel>
                <FormLabel label="Schedule" hint="optional">
                  <Input
                    type="datetime-local"
                    value={form.scheduledAt}
                    onChange={(event) =>
                      setForm((current) => ({
                        ...current,
                        scheduledAt: event.target.value,
                      }))
                    }
                  />
                </FormLabel>
              </div>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(220px,0.7fr)]">
                <FormLabel label="Message">
                  <Textarea
                    rows={7}
                    value={form.message}
                    placeholder="Write the message your customers should receive…"
                    onChange={(event) => {
                      setFormError(null)
                      setForm((current) => ({
                        ...current,
                        message: event.target.value,
                      }))
                    }}
                  />
                </FormLabel>
                <div className="rounded-lg border border-border bg-background p-4">
                  <p className="text-xs font-medium text-foreground-muted">
                    Preview
                  </p>
                  <p className="mt-2 text-sm break-words whitespace-pre-wrap">
                    {form.advancedTemplate
                      ? (() => {
                          try {
                            return messagePreview(
                              parseObject(form.template, "Structured message")
                            )
                          } catch {
                            return "Add valid JSON to preview the message."
                          }
                        })()
                      : form.message ||
                        "Your message preview will appear here."}
                  </p>
                  <p className="mt-4 text-xs text-foreground-muted">
                    Telegram will deliver this message after the audience is
                    frozen.
                  </p>
                </div>
              </div>

              <details
                className="group rounded-lg border border-border bg-background"
                onToggle={(event) =>
                  setForm((current) => ({
                    ...current,
                    advancedTemplate: event.currentTarget.open,
                  }))
                }
              >
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  Structured message
                  <span className="text-xs font-normal text-foreground-muted">
                    Advanced JSON
                  </span>
                </summary>
                <div className="border-t border-border p-4">
                  <FormLabel label="Message payload" hint="JSON object">
                    <Textarea
                      rows={6}
                      value={form.template}
                      onChange={(event) => {
                        setFormError(null)
                        setForm((current) => ({
                          ...current,
                          template: event.target.value,
                          advancedTemplate: true,
                        }))
                      }}
                    />
                  </FormLabel>
                  <p className="mt-2 text-xs text-foreground-muted">
                    Use this when the channel needs fields beyond a plain text
                    message. Include a non-empty <code>text</code>,{" "}
                    <code>body</code> or <code>message</code> field.
                  </p>
                </div>
              </details>

              <details className="group rounded-lg border border-border bg-background">
                <summary className="flex cursor-pointer list-none items-center justify-between px-4 py-3 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                  Audience and exclusions{" "}
                  <span className="text-xs font-normal text-foreground-muted group-open:hidden">
                    All eligible contacts by default
                  </span>
                  <span className="hidden text-xs font-normal text-foreground-muted group-open:inline">
                    Rules are evaluated when the audience is frozen
                  </span>
                </summary>
                <div className="grid gap-4 border-t border-border p-4 md:grid-cols-2">
                  <FormLabel label="Audience rules" hint="JSON">
                    <Textarea
                      rows={5}
                      placeholder={"{} = all eligible contacts"}
                      value={form.audience}
                      onChange={(event) => {
                        setFormError(null)
                        setForm((current) => ({
                          ...current,
                          audience: event.target.value,
                        }))
                      }}
                    />
                  </FormLabel>
                  <FormLabel label="Exclusion rules" hint="JSON">
                    <Textarea
                      rows={5}
                      placeholder={"{} = no additional exclusions"}
                      value={form.suppression}
                      onChange={(event) => {
                        setFormError(null)
                        setForm((current) => ({
                          ...current,
                          suppression: event.target.value,
                        }))
                      }}
                    />
                  </FormLabel>
                </div>
              </details>

              {formError ? <Notice variant="error">{formError}</Notice> : null}
              {connections.error ? (
                <Notice variant="error">
                  Connections could not be loaded: {connections.error.message}
                </Notice>
              ) : null}
              {create.error ? (
                <Notice variant="error">{create.error.message}</Notice>
              ) : null}
              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreate(false)}
                >
                  Cancel
                </Button>
                <Button type="submit" loading={create.isPending}>
                  Create campaign
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>
    </BuildFrame>
  )
}

function CampaignInspector({
  campaign,
  deliveries,
  loading,
  error,
  refresh,
}: {
  campaign: Campaign | null
  deliveries: Delivery[]
  loading: boolean
  error: Error | null
  refresh: () => void
}) {
  if (!campaign)
    return (
      <BuildEmpty
        title="Select a campaign"
        description="Choose a campaign to inspect its audience and delivery progress."
      />
    )

  return (
    <BuildFormCard
      title={campaign.name}
      description={`${campaign.channel || "Channel"} · ${formatDate(campaign.scheduledAt)}`}
      footer={
        <div className="flex items-center justify-between gap-2">
          <BuildStatus status={campaign.status} />
          <Button size="sm" variant="ghost-muted" onClick={refresh}>
            Refresh deliveries
          </Button>
        </div>
      }
    >
      <div className="grid grid-cols-3 gap-2 text-center text-xs">
        <div className="rounded-md border border-border bg-background px-2 py-2">
          <p className="text-foreground-muted">Audience</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {campaign.audienceCount ?? 0}
          </p>
        </div>
        <div className="rounded-md border border-border bg-background px-2 py-2">
          <p className="text-foreground-muted">Delivered</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {campaign.deliveredCount ?? 0}
          </p>
        </div>
        <div className="rounded-md border border-border bg-background px-2 py-2">
          <p className="text-foreground-muted">Replies</p>
          <p className="mt-1 text-lg font-semibold tabular-nums">
            {campaign.repliedCount ?? 0}
          </p>
        </div>
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium text-foreground-muted">
            Delivery receipts
          </p>
          <span className="text-xs text-foreground-muted">
            {deliveries.length} total
          </span>
        </div>
        {loading ? (
          <p className="text-xs text-foreground-muted">Loading deliveries…</p>
        ) : null}
        {!loading && error ? (
          <Notice variant="error">{error.message}</Notice>
        ) : null}
        {!loading && !error && !deliveries.length ? (
          <p className="text-xs text-foreground-muted">
            No delivery jobs have been queued yet.
          </p>
        ) : null}
        {deliveries.map((delivery) => (
          <div
            key={delivery.id}
            className="rounded-md border border-border bg-background px-3 py-2 text-xs"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-foreground-muted">
                Recipient{" "}
                {delivery.audienceId ? delivery.audienceId.slice(0, 8) : "—"}
              </span>
              <BuildStatus status={delivery.state} />
            </div>
            <div className="mt-1 flex flex-wrap gap-x-3 text-foreground-muted">
              <span>Attempts {delivery.attemptCount ?? 0}</span>
              {delivery.updatedAt ? (
                <span>{formatDate(delivery.updatedAt)}</span>
              ) : null}
            </div>
            {delivery.lastError ? (
              <p className="mt-1 text-destructive">{delivery.lastError}</p>
            ) : null}
          </div>
        ))}
      </div>
    </BuildFormCard>
  )
}
