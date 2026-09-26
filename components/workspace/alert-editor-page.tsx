"use client"

import { useCallback, useState, type FormEvent } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { LoadingState } from "@/components/ui/loading-state"
import { useRemote } from "@/components/tracer/hooks"
import { HeaderSlot } from "@/components/tracer/collection-header"
import { workspaceRequest } from "@/lib/workspace-api"
import {
  alertConfigSchema,
  defaultAlertConfig,
  type AlertConfig,
  type AlertRule,
  type AlertDetailResponse,
} from "@/src/lib/alerts/contracts"
import {
  alertTemplates,
  alertIntervals,
  alertWindows,
} from "@/src/lib/alerts/templates"
import { parseAlertFilter } from "@/src/lib/alerts/filter"

type PageProps = { projectId: string; projectSlug: string; canManage: boolean }
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to save alert. Try again."

export function NewAlertPage({
  templateId,
  ...props
}: PageProps & { templateId?: string }) {
  const template = alertTemplates.find((item) => item.id === templateId)
  return (
    <AlertForm
      key={`${props.projectId}:${template?.id ?? "empty"}`}
      {...props}
      initialConfig={template?.config}
    />
  )
}

export function EditAlertPage({
  alertId,
  ...props
}: PageProps & { alertId: string }) {
  const endpoint = `/api/projects/${encodeURIComponent(props.projectId)}/alerts/${encodeURIComponent(alertId)}`
  const load = useCallback(
    (signal: AbortSignal) =>
      workspaceRequest<AlertDetailResponse>(endpoint, { signal }),
    [endpoint]
  )
  const state = useRemote(load, [props.projectId, alertId])
  if (state.error)
    return (
      <Notice variant="error" role="alert" className="m-4">
        <p>{state.error.message}</p>
        <Button
          variant="outline"
          size="sm"
          className="mt-2"
          onClick={state.refresh}
        >
          Retry
        </Button>
      </Notice>
    )
  if (!state.data) return <LoadingState label="Loading alert" />
  return (
    <AlertForm
      key={`${props.projectId}:${alertId}`}
      {...props}
      alert={state.data.alert}
    />
  )
}

function AlertForm({
  projectId,
  projectSlug,
  canManage,
  alert,
  initialConfig,
}: PageProps & { alert?: AlertRule; initialConfig?: AlertConfig }) {
  const router = useRouter()
  const base = `/p/${encodeURIComponent(projectSlug)}/alerts`
  const back = alert ? `${base}/${encodeURIComponent(alert.id)}` : base
  const endpoint = `/api/projects/${encodeURIComponent(projectId)}/alerts`
  const [config, setConfig] = useState<AlertConfig>(
    alert?.config ?? initialConfig ?? defaultAlertConfig
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const update = <K extends keyof AlertConfig>(
    key: K,
    value: AlertConfig[K]
  ) => {
    setConfig((current) => ({ ...current, [key]: value }))
    setError(null)
  }
  let filterError: string | null = null
  try {
    parseAlertFilter(config.filter)
  } catch (reason) {
    filterError = errorMessage(reason)
  }
  const normalized = {
    ...config,
    name: config.name.trim(),
    description: config.description.trim(),
    filter: config.filter.trim(),
    webhookUrl: config.action === "webhook" ? config.webhookUrl.trim() : "",
  }
  const dirty =
    !alert || JSON.stringify(normalized) !== JSON.stringify(alert.config)
  const valid =
    alertConfigSchema.safeParse(normalized).success &&
    !filterError &&
    (config.action !== "webhook" || !!config.webhookUrl.trim())
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canManage || !dirty || !valid || pending) return
    setPending(true)
    setError(null)
    try {
      const result = await workspaceRequest<{ alert: AlertRule }>(
        alert ? `${endpoint}/${encodeURIComponent(alert.id)}` : endpoint,
        {
          method: alert ? "PATCH" : "POST",
          body: JSON.stringify(
            alert
              ? { revision: alert.revision, config: normalized }
              : normalized
          ),
        }
      )
      router.push(`${base}/${encodeURIComponent(result.alert.id)}`)
    } catch (reason) {
      setError(errorMessage(reason))
      setPending(false)
    }
  }
  if (!canManage)
    return (
      <Notice variant="info" className="m-4">
        Only project owners and admins can configure alerts.{" "}
        <Link className="underline" href={back}>
          Back to alerts
        </Link>
      </Notice>
    )
  return (
    <form
      onSubmit={(event) => void submit(event)}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <HeaderSlot name="title">
        <h1 className="truncate text-sm font-medium">
          {alert ? `Edit ${alert.config.name}` : "New alert"}
        </h1>
      </HeaderSlot>
      <div
        role="group"
        aria-label="Alert editor controls"
        className="flex shrink-0 items-center justify-end gap-2 border-b border-border px-3 py-2"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => router.push(back)}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!dirty || !valid}
          loading={pending}
        >
          <Save className="size-4" />
          {alert ? "Save changes" : "Create alert"}
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <fieldset
          disabled={pending}
          className="mx-auto w-full max-w-3xl space-y-6 px-4 py-6 sm:px-6"
        >
          <div className="space-y-2">
            <label htmlFor="alert-name" className="text-sm font-medium">
              Name
            </label>
            <Input
              id="alert-name"
              placeholder="Enter alert name"
              value={config.name}
              maxLength={160}
              required
              onChange={(event) => update("name", event.target.value)}
            />
          </div>
          <details
            open={!!config.description || undefined}
            className="rounded-lg border border-border bg-muted p-3"
          >
            <summary className="cursor-pointer text-sm text-foreground-muted">
              Description (optional)
            </summary>
            <Textarea
              aria-label="Description"
              className="mt-3"
              value={config.description}
              maxLength={2000}
              onChange={(event) => update("description", event.target.value)}
            />
          </details>
          <div className="flex items-center justify-between gap-4">
            <div>
              <label htmlFor="alert-enabled" className="text-sm font-medium">
                Enabled
              </label>
              <p className="text-xs text-foreground-muted">
                Pause this alert without deleting it.
              </p>
            </div>
            <Switch
              id="alert-enabled"
              checked={config.enabled}
              onCheckedChange={(value) => update("enabled", value)}
            />
          </div>
          <div className="space-y-2">
            <label htmlFor="alert-type" className="text-sm font-medium">
              Alert type
            </label>
            <Select
              id="alert-type"
              value={config.type}
              onChange={(event) =>
                update("type", event.target.value as AlertConfig["type"])
              }
            >
              <option value="log_event">Log event</option>
              <option value="time_window">Time-window count</option>
            </Select>
            <p className="text-xs text-foreground-muted">
              {config.type === "log_event"
                ? "Evaluate new and updated traces and spans. Existing logs are not replayed."
                : "Count matching traces and spans by start time. Checked every minute."}
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="alert-filter" className="text-sm font-medium">
              SQL filter clause
            </label>
            <Textarea
              id="alert-filter"
              className="min-h-32 font-mono text-xs"
              placeholder="status = 'errored'"
              value={config.filter}
              maxLength={2000}
              aria-invalid={!!filterError}
              aria-describedby="alert-filter-help"
              onChange={(event) => update("filter", event.target.value)}
            />
            <p id="alert-filter-help" className="text-xs text-foreground-muted">
              Optional. Use comparisons, AND, OR and parentheses. An empty
              filter matches all logs.
            </p>
            {filterError && (
              <p role="alert" className="text-xs text-destructive">
                {filterError}
              </p>
            )}
            <div className="flex flex-wrap gap-2">
              {[
                "status = 'errored'",
                "kind = 'llm' AND duration_ms > 5000",
                "resource = 'trace'",
              ].map((example) => (
                <Button
                  type="button"
                  key={example}
                  variant="outline"
                  size="sm"
                  className="h-auto text-left font-mono text-xs whitespace-normal"
                  onClick={() => update("filter", example)}
                >
                  {example}
                </Button>
              ))}
            </div>
            <details className="text-xs text-foreground-muted">
              <summary className="cursor-pointer">Filter reference</summary>
              <p className="mt-2 leading-5">
                Fields: name, status, kind, resource (trace or span),
                duration_ms, cost_usd, created, id, trace_id and
                span_attributes.&lt;key&gt;. Use =, !=, &gt;, &gt;=, &lt;,
                &lt;=, LIKE, IS NULL or IS NOT NULL. Attribute keys are flat,
                such as span_attributes.gen_ai.request.model. Dates accept ISO
                strings or now() - interval &apos;1 day&apos;.
              </p>
            </details>
          </div>
          {config.type === "time_window" && (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="alert-window" className="text-sm font-medium">
                  Time window
                </label>
                <Select
                  id="alert-window"
                  value={config.windowSeconds}
                  onChange={(event) =>
                    update("windowSeconds", Number(event.target.value))
                  }
                >
                  {alertWindows.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="space-y-2">
                <label
                  htmlFor="alert-threshold"
                  className="text-sm font-medium"
                >
                  Minimum matching logs
                </label>
                <Input
                  id="alert-threshold"
                  type="number"
                  min={1}
                  max={1000000}
                  required
                  value={config.threshold}
                  onChange={(event) =>
                    update("threshold", Number(event.target.value))
                  }
                />
              </div>
            </div>
          )}
          <div className="space-y-2">
            <label htmlFor="alert-interval" className="text-sm font-medium">
              Notify interval
            </label>
            <Select
              id="alert-interval"
              value={config.notifyIntervalSeconds}
              onChange={(event) =>
                update("notifyIntervalSeconds", Number(event.target.value))
              }
            >
              {alertIntervals.map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
            <p className="text-xs leading-5 text-foreground-muted">
              Minimum time between notifications. Matching events arriving
              during this interval are skipped. Time-window alerts can fire
              again while their threshold remains met.
            </p>
          </div>
          <div className="space-y-2">
            <label htmlFor="alert-action" className="text-sm font-medium">
              Action type
            </label>
            <Select
              id="alert-action"
              value={config.action}
              onChange={(event) =>
                update("action", event.target.value as AlertConfig["action"])
              }
            >
              <option value="in_app">In-app notification</option>
              <option value="webhook">Webhook</option>
            </Select>
            <p className="text-xs text-foreground-muted">
              {config.action === "in_app"
                ? "Record notifications in this project's notification history."
                : "POST a JSON notification to your endpoint. Delivery results appear in history."}
            </p>
          </div>
          {config.action === "webhook" && (
            <div className="space-y-2">
              <label htmlFor="alert-webhook" className="text-sm font-medium">
                Webhook URL
              </label>
              <Input
                id="alert-webhook"
                type="url"
                required
                placeholder="https://example.com/alerts"
                value={config.webhookUrl}
                maxLength={2048}
                onChange={(event) => update("webhookUrl", event.target.value)}
              />
              <p className="text-xs text-foreground-muted">
                Your receiver should accept JSON and return HTTP 2xx. Retries
                reuse the same Idempotency-Key.
              </p>
            </div>
          )}
          {error && (
            <Notice variant="error" role="alert">
              {error}
            </Notice>
          )}
        </fieldset>
      </div>
    </form>
  )
}
