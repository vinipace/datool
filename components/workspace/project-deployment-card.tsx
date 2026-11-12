"use client"

import Link from "next/link"
import { useState } from "react"
import { useRemote } from "@/components/tracer/hooks"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card"
import { Textarea } from "@/components/ui/textarea"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"

type Deployment = {
  id: string
  createdAt: string
  agents: string[]
  tools: string[]
  sources: string[]
  mcpPath: string
}
export function ProjectDeploymentCard({
  projectId,
  projectSlug,
  origin,
}: {
  projectId: string
  projectSlug: string
  origin: string
}) {
  const [copyStatus, setCopyStatus] = useState("")
  const state = useRemote(
    async (signal) => {
      const response = await fetch("/api/deployments", {
        headers: { "x-project-id": projectId },
        signal,
      })
      if (!response.ok)
        throw new Error("Unable to load the project deployment.")
      const body = await response.json()
      return body.data as Deployment | null
    },
    [projectId]
  )
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"
  const command = `export DATOOL_BASE_URL=${quote(origin)}\nexport DATOOL_PROJECT_ID=${quote(projectId)}\nexport DATOOL_API_KEY='your-api-key'\ndatool deploy .`
  return (
    <Card>
      <CardHeader>
        <CardTitle>Deploy from a folder</CardTitle>
        <CardDescription>
          Publish agents, skills, MCP tools and company sources from your
          codebase.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-5">
        <p className="text-sm text-foreground-muted">
          Create an{" "}
          <Link
            className="underline"
            href={`/p/${encodeURIComponent(projectSlug)}/settings/api-keys`}
          >
            API key
          </Link>{" "}
          with Build read, write and run permissions. Your organization’s
          sandbox and storage connections power the deployment.
        </p>
        <Textarea
          aria-label="CLI deployment commands"
          value={command}
          readOnly
          rows={4}
          className="font-mono text-xs"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(command)
                setCopyStatus("Commands copied.")
              } catch {
                setCopyStatus("Select the commands above to copy them.")
              }
            }}
          >
            Copy commands
          </Button>
          <Button asChild size="sm" variant="ghost">
            <Link href="/docs/guides/project-deployment">Deployment guide</Link>
          </Button>
          {copyStatus && (
            <span role="status" className="text-sm text-foreground-muted">
              {copyStatus}
            </span>
          )}
        </div>
        {state.isLoading ? (
          <p role="status" className="text-sm text-foreground-muted">
            Loading deployment…
          </p>
        ) : state.error ? (
          <Notice variant="error">
            <p>{state.error.message}</p>
            <Button size="sm" variant="outline" onClick={state.refresh}>
              Retry
            </Button>
          </Notice>
        ) : state.data ? (
          <div className="space-y-2">
            <p className="text-sm">
              {state.data.agents.length}{" "}
              {state.data.agents.length === 1 ? "agent" : "agents"} ·{" "}
              {state.data.tools.length}{" "}
              {state.data.tools.length === 1 ? "tool" : "tools"} ·{" "}
              {state.data.sources.length}{" "}
              {state.data.sources.length === 1 ? "source" : "sources"}
            </p>
            <p className="text-xs text-foreground-muted">
              Deployed {new Date(state.data.createdAt).toLocaleString()}
            </p>
            <label htmlFor="project-mcp-url" className="text-sm font-medium">
              Project MCP URL
            </label>
            <Input
              id="project-mcp-url"
              readOnly
              value={origin + state.data.mcpPath}
              className="font-mono text-xs"
            />
            <p className="text-xs text-foreground-muted">
              Connect using a Bearer API key with Build read and run
              permissions.
            </p>
          </div>
        ) : (
          <p className="text-sm text-foreground-muted">
            No folder deployed yet. Start with agents/, tools/, skills/ and
            sources/.
          </p>
        )}
        <Button
          size="sm"
          variant="ghost"
          loading={state.isRefreshing}
          onClick={state.refresh}
        >
          Refresh deployment
        </Button>
      </CardContent>
    </Card>
  )
}
