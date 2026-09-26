"use client"

import { useEffect, useRef, useState } from "react"
import { Copy, KeyRound } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { CodeEditor } from "@/components/ui/code-editor"
import { Notice } from "@/components/ui/notice"
import { Textarea } from "@/components/ui/textarea"
import { workspaceScopes } from "@/src/lib/auth/permissions"
import {
  CollectionDisplaySkeleton,
  CollectionHistogramSkeleton,
  CollectionTableSkeleton,
} from "@/components/ui/collection-skeleton"
import { HeaderSlot } from "./collection-header"
import { useProjectScope } from "./project-scope-context"
import { tracerApi } from "./api"

type Access = { canManage: boolean; creationDisabled: boolean }

/** Only mounted after a successful empty filtered trace response. */
export function TraceOnboarding({ fallback }: { fallback: React.ReactNode }) {
  const scope = useProjectScope()
  const [empty, setEmpty] = useState<boolean | null>(null)
  const [access, setAccess] = useState<Access | null>(null)
  const [error, setError] = useState("")
  const [secret, setSecret] = useState("")
  const [origin, setOrigin] = useState("")
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState("")
  const [attempt, setAttempt] = useState(0)
  const lock = useRef(false)
  const organizationId = scope?.organizationId
  const projectId = scope?.projectId
  const endpoint = `/api/organizations/${encodeURIComponent(organizationId ?? "")}/api-keys`

  useEffect(() => {
    if (!projectId || !organizationId) return
    let active = true
    async function load() {
      setError("")
      setOrigin(window.location.origin)
      try {
        const traces = await tracerApi.traces.list({ limit: 1 })
        if (!active) return
        setEmpty(traces.items.length === 0)
        if (traces.items.length) return
        const response = await fetch(`${endpoint}?limit=1`, {
          cache: "no-store",
        })
        if (!response.ok)
          throw new Error("Unable to check API key permissions. Try again.")
        const result = await response.json()
        if (active) setAccess(result.data)
      } catch (cause) {
        if (active) setError((cause as Error).message)
      }
    }
    void load()
    return () => {
      active = false
    }
  }, [projectId, organizationId, endpoint, attempt])

  async function createKey() {
    if (lock.current || secret) return
    lock.current = true
    setBusy(true)
    setError("")
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: `Application ${projectId}`.slice(0, 100),
          scopes: workspaceScopes,
          expiresIn: null,
        }),
      })
      const result = await response.json()
      if (!response.ok)
        throw new Error(result.error?.message ?? "Unable to create API key.")
      setSecret(result.data.key)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      lock.current = false
      setBusy(false)
    }
  }

  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(label)
      setError("")
    } catch {
      setError("Clipboard access failed. Select and copy the text below.")
    }
  }

  if (!scope || empty === false) return fallback
  // An empty filtered result does not prove the project has no traces.
  if (empty === null) {
    if (error)
      return (
        <Notice variant="error" role="alert" className="m-5">
          {error}{" "}
          <Button
            size="sm"
            variant="outline"
            onClick={() => setAttempt((value) => value + 1)}
          >
            Retry
          </Button>
        </Notice>
      )
    return (
      <>
        <HeaderSlot name="display">
          <CollectionDisplaySkeleton />
        </HeaderSlot>
        <CollectionHistogramSkeleton />
        <CollectionTableSkeleton label="Checking project traces…" />
      </>
    )
  }
  const env = `DATOOL_BASE_URL=${origin}\nDATOOL_PROJECT_ID=${projectId}\nDATOOL_API_KEY=${secret || "<your-api-key>"}`
  const instructions = `Connect this application to Datool at ${origin}, project ${projectId}.
Read ${origin}/docs/get-started/first-trace and ${origin}/docs/tracing/instrumentation before making changes.
Inspect the application's framework, runtime, installed AI SDK version, and existing OpenTelemetry setup. Use the application's package manager and the documented integration for that stack.
For Node.js, use @datool/sdk. For existing OpenTelemetry instrumentation, register DatoolSpanProcessor from @datool/sdk/otel with the existing provider before model calls; configure a new provider only if one does not already exist. Use the telemetry API for the installed AI SDK version and await processor.forceFlush() within the request or shutdown lifecycle.
Read DATOOL_BASE_URL, DATOOL_PROJECT_ID, and DATOOL_API_KEY from the application's ignored .env.local file (or equivalent server-side environment). Preserve existing configuration. Never commit the API key, expose it to browser code, or include it in logs or traces.
Instrument a real application call, run it, and verify that the trace is persisted in this Datool project. HTTP 202 alone is not proof of persistence. Report the files changed and the verification result.`
  const agentPrompt = `${instructions}

Add these connection settings to the ignored server-side environment file:
\`\`\`dotenv
${env}
\`\`\``

  return (
    <section
      aria-label="Connect your application"
      className="mx-auto flex w-full max-w-2xl flex-col gap-4 p-4 sm:p-8"
    >
      <div>
        <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Send your first trace
        </h2>
        <p className="mt-1 text-sm text-foreground-muted">
          Connect your application to this project. Traces will appear here
          automatically.
        </p>
      </div>
      <Card className="overflow-hidden bg-background">
        <Tabs defaultValue="auto" onValueChange={() => setCopied("")}>
          <CardHeader className="border-b border-border py-0">
            <TabsList variant="underline" aria-label="Setup method">
              <TabsTrigger value="auto">Auto</TabsTrigger>
              <TabsTrigger value="manual">Manual</TabsTrigger>
            </TabsList>
          </CardHeader>
          <CardContent className="space-y-6 pt-5">
            {error && (
              <Notice variant="error" role="alert">
                {error}{" "}
                {!access && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setAttempt((value) => value + 1)}
                  >
                    Retry
                  </Button>
                )}
              </Notice>
            )}
            <section className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">1. Create an API key</h3>
              <p className="text-sm text-foreground-muted">
                Grants all API permissions across this organization. Manage or
                revoke it in API keys.
              </p>
              {!access ? (
                <p role="status" className="text-sm text-foreground-muted">
                  Checking permissions…
                </p>
              ) : !access.canManage ? (
                <Notice>
                  Ask an organization owner or admin to create an API key.
                </Notice>
              ) : access.creationDisabled ? (
                <Notice>
                  API key creation is disabled for this organization. Enable it
                  in API keys settings.
                </Notice>
              ) : (
                <Button
                  className="self-start"
                  size="sm"
                  loading={busy}
                  disabled={!!secret}
                  onClick={createKey}
                >
                  <KeyRound />
                  {secret ? "API key created" : "Generate API key"}
                </Button>
              )}
            </section>
            <TabsContent
              value="auto"
              className="space-y-3 border-t border-border pt-6"
            >
              <h3 className="text-sm font-medium">
                2. Set up with your coding agent
              </h3>
              <p className="text-sm text-foreground-muted">
                Paste this prompt into your coding agent. It includes your
                project settings and API key so the agent can configure your app
                and verify its first trace.
              </p>
              <Button
                size="sm"
                disabled={!secret}
                onClick={() => copy(agentPrompt, "Setup prompt copied")}
              >
                <Copy />
                Copy setup prompt
              </Button>
              <p className="text-xs text-foreground-muted">
                Save the prompt before leaving this page. Your key is only shown
                once.
              </p>
              <details className="text-sm text-foreground-muted">
                <summary>View prompt</summary>
                <Textarea
                  aria-label="Agent setup prompt"
                  readOnly
                  rows={10}
                  value={agentPrompt}
                  className="mt-2 text-xs"
                />
              </details>
            </TabsContent>
            <TabsContent value="manual" className="space-y-6">
              <section className="flex flex-col gap-3 border-t border-border pt-6">
                <h3 className="text-sm font-medium">
                  2. Add to your application's .env.local
                </h3>
                <p className="text-sm text-foreground-muted">
                  Save the key before leaving this page. It is only shown once.
                </p>
                <CodeEditor
                  label="Datool environment variables"
                  language="ini"
                  variant="snippet"
                  readOnly
                  autoSize
                  lineNumbers={false}
                  value={env}
                  onChange={() => undefined}
                />
                <Button
                  className="self-start"
                  size="sm"
                  variant="outline"
                  disabled={!secret}
                  onClick={() => copy(env, "Environment variables copied")}
                >
                  <Copy />
                  Copy .env
                </Button>
              </section>
              <section className="flex flex-col gap-3 border-t border-border pt-6">
                <h3 className="text-sm font-medium">
                  3. Instrument your application
                </h3>
                <p className="text-sm text-foreground-muted">
                  Give these instructions to your coding agent, then run your
                  application.
                </p>
                <Button
                  className="self-start"
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    copy(instructions, "Setup instructions copied")
                  }
                >
                  <Copy />
                  Copy setup instructions
                </Button>
                <details className="text-sm text-foreground-muted">
                  <summary>View instructions</summary>
                  <Textarea
                    aria-label="Agent setup instructions"
                    readOnly
                    rows={8}
                    value={instructions}
                    className="mt-2 text-xs"
                  />
                </details>
              </section>
            </TabsContent>
          </CardContent>
          <CardFooter className="border-t border-border pt-4">
            <p role="status" className="text-sm text-foreground-muted">
              {copied || "Waiting for your first trace…"}
            </p>
          </CardFooter>
        </Tabs>
      </Card>
    </section>
  )
}
