"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ArrowLeft, Check, Copy, Pause, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { SyntaxCode } from "@/components/ui/syntax-code"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useWorkspaceHref } from "@/components/tracer/workspace-path"
import { AgentSidebarNavigation } from "@/components/build/shared/agent-sidebar"
import { ChannelIcon } from "@/components/build/shared/channel-identity"
import { BuildStatus } from "@/components/build/operations/build-page"
import { buildApi } from "@/components/build/operations/build-api"
import type { ChannelConnection } from "@/src/lib/build/channels"
import type { ManagedAgent } from "@/src/lib/build/contracts"

function Snippet({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState(false)
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="flex items-center justify-between gap-3 bg-muted px-4 py-2">
        <span className="truncate font-mono text-xs text-foreground-muted">
          {label}
        </span>
        <Button
          variant="ghost-muted"
          size="icon-sm"
          aria-label={`Copy ${label}`}
          onClick={() => {
            void navigator.clipboard
              .writeText(code)
              .then(() => {
                setCopied(true)
                setError(false)
              })
              .catch(() => setError(true))
          }}
        >
          {copied ? <Check /> : <Copy />}
        </Button>
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-6">
        <SyntaxCode language="javascript" text={code} />
      </pre>
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          Could not copy. Select the code to copy it.
        </p>
      )}
    </div>
  )
}

export function ReactSdkEditor({
  connection,
  agent,
  fromAgent = false,
}: {
  connection: ChannelConnection
  agent: ManagedAgent
  fromAgent?: boolean
}) {
  const href = useWorkspaceHref()
  const router = useRouter()
  const [saved, setSaved] = React.useState(connection)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string>()
  const agentHref = href(`/build/agents/${agent.id}`)
  const baseUrl =
    typeof window === "undefined"
      ? "https://www.trydatool.com"
      : window.location.origin
  const credentials = `  apiKey: process.env.DATOOL_API_KEY!,\n  projectId: ${JSON.stringify(agent.projectId)},\n  baseUrl: ${JSON.stringify(baseUrl)},`
  const server = `import { createDatoolHandler } from "@datool/react/server"\nimport { auth } from "@/lib/auth" // Your app's authentication\n\nexport const POST = createDatoolHandler({\n${credentials}\n  connectionId: ${JSON.stringify(saved.id)},\n  async config({ req }) {\n    const { orgId, userId } = await auth(req)\n    if (!orgId || !userId) {\n      return new Response("Unauthorized", { status: 401 })\n    }\n    return { userId, drive: \`drive_\${orgId}\` }\n  },\n})`
  const client = `"use client"\n\nimport { DatoolChat } from "@datool/react"\nimport "@datool/react/styles.css"\n\nexport function Assistant() {\n  return <DatoolChat endpoint="/api/datool" />\n}`
  const proactive = `import { createDatoolClient } from "@datool/sdk/agents"\n\nconst datool = createDatoolClient({\n${credentials}\n})\n\n// Resolve these from your authenticated server context.\nconst agent = datool.agent({\n  connectionId: ${JSON.stringify(saved.id)},\n  userId,\n  drive: \`drive_\${orgId}\`,\n})\n\nawait agent.files.write("context/company.md", companyContext)\nawait agent.messages.send("Review our company context.")\n\nconst task = await agent.tasks.create({\n  name: "Morning briefing",\n  prompt: "Review our files and send a useful morning briefing.",\n  schedule: { kind: "cron", expression: "0 9 * * 1-5" },\n  timezone: "America/Sao_Paulo",\n})\n\nawait agent.tasks.runNow(task.id)\n// await agent.tasks.pause(task)`
  async function toggle() {
    setPending(true)
    setError(undefined)
    try {
      await buildApi.call("build_update_channel_status", {
        connectionId: saved.id,
        status: saved.status === "connected" ? "paused" : "connected",
      })
      const result = await buildApi.call<{ connection: ChannelConnection }>(
        "build_get_channel",
        { connectionId: saved.id }
      )
      setSaved(result.connection)
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not update channel."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <>
      {fromAgent && (
        <AgentSidebarNavigation
          agentId={agent.id}
          name={agent.name}
          appearance={agent.configuration.appearance}
          active="channels"
          canConfigure
          agentHref={agentHref}
          onChange={(section) => router.push(`${agentHref}?section=${section}`)}
        />
      )}
      <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 sm:px-6">
        <Button asChild variant="ghost-muted" size="sm">
          <Link
            href={
              fromAgent
                ? `${agentHref}?section=channels`
                : href("/build/integrations")
            }
          >
            <ArrowLeft />
            Channels
          </Link>
        </Button>
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <ChannelIcon channel="api" />
            <div>
              <div className="flex items-center gap-3">
                <h1 className="text-xl font-semibold">React SDK</h1>
                <BuildStatus status={saved.status} />
              </div>
              <p className="mt-1 text-sm text-foreground-muted">
                Your agent, inside your app.
              </p>
            </div>
          </div>
          <Button
            variant={saved.status === "connected" ? "outline" : "default"}
            loading={pending}
            onClick={() => void toggle()}
          >
            {saved.status === "connected" ? <Pause /> : <Play />}
            {saved.status === "connected"
              ? "Pause channel"
              : saved.status === "paused"
                ? "Resume channel"
                : "Enable channel"}
          </Button>
        </header>
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
        <Tabs defaultValue="install">
          <TabsList>
            <TabsTrigger value="install">Installation</TabsTrigger>
            <TabsTrigger value="proactive">Proactive agent</TabsTrigger>
          </TabsList>
          <TabsContent value="install" className="space-y-8 pt-6">
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">1. Install the packages</h2>
              <Snippet
                label="Terminal"
                code="npm install @datool/react @datool/sdk"
              />
            </section>
            <section className="space-y-3">
              <div>
                <h2 className="text-sm font-semibold">
                  2. Connect your server
                </h2>
                <p className="mt-1 text-sm text-foreground-muted">
                  Add a server API key with Build run access to your
                  environment. Your app authenticates each request and chooses
                  the drive.
                </p>
              </div>
              <Button asChild variant="outline" size="sm">
                <Link href={href("/settings/api-keys")}>Manage API keys</Link>
              </Button>
              <Snippet label="app/api/datool/route.ts" code={server} />
            </section>
            <section className="space-y-3">
              <h2 className="text-sm font-semibold">3. Add the chat</h2>
              <p className="text-sm text-foreground-muted">
                Place the component anywhere in your app. It talks only to your
                server endpoint.
              </p>
              <Snippet label="components/assistant.tsx" code={client} />
            </section>
          </TabsContent>
          <TabsContent value="proactive" className="space-y-5 pt-6">
            <div className="space-y-2">
              <h2 className="text-base font-semibold">
                Give your agent context and a schedule
              </h2>
              <p className="text-sm text-foreground-muted">
                Manage files, send messages and schedule work from your server.
                Results appear in the same chat, even when the user did not
                start the conversation.
              </p>
              <p className="text-sm text-foreground-muted">
                Use a key with Build read, write and run access for file and
                task management.
              </p>
            </div>
            {!(agent.appliedConfiguration ?? agent.configuration).sandbox
              .enabled && (
              <Notice>
                Enable the agent’s{" "}
                <Link
                  className="underline"
                  href={`${agentHref}?section=sandbox`}
                >
                  Sandbox
                </Link>{" "}
                to use persistent drives. Remove <code>drive</code> from your
                configuration for chat without files.
              </Notice>
            )}
            <Snippet label="lib/assistant.ts" code={proactive} />
            <p className="text-xs text-foreground-muted">
              Files are shared within the selected drive. Chat history and tasks
              stay with the authenticated user. Scheduled work continues on
              Datool’s worker when your app is closed; replies appear when chat
              reconnects.
            </p>
          </TabsContent>
        </Tabs>
      </div>
    </>
  )
}
