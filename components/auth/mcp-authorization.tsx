"use client"
import { useEffect, useState } from "react"
import { useSearchParams } from "next/navigation"
import Link from "next/link"
import { authClient } from "@/lib/auth-client"
import { mcpScopes } from "@/src/lib/auth/permissions"
type Project = { id: string; name: string; organizationName: string }
export function McpAuthorization({ consent = false }: { consent?: boolean }) {
  const search = useSearchParams()
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState(search.get("datool_project") ?? "")
  const [clientName, setClientName] = useState(
    search.get("client_id") ?? "MCP client"
  )
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const requested = (search.get("scope") ?? "").split(/\s+/).filter(Boolean)
  useEffect(() => {
    let active = true
    void fetch("/api/mcp/authorization")
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok)
          throw new Error(body.error?.message ?? "Sign in to continue.")
        if (active) {
          setProjects(body.data.projects)
          setReady(true)
        }
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    const clientId = search.get("client_id")
    if (clientId)
      void authClient.oauth2
        .publicClient({ query: { client_id: clientId } })
        .then((result) => {
          if (active && result.data?.client_name)
            setClientName(result.data.client_name)
        })
    return () => {
      active = false
    }
  }, [search])
  async function submit(accept: boolean) {
    setBusy(true)
    setError(undefined)
    try {
      const params = new URLSearchParams(search.toString())
      // App-only display state must not change the provider-signed OAuth query.
      params.delete("datool_project")
      const response = await fetch("/api/mcp/authorization", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: consent ? "consent" : "continue",
          projectId,
          oauth_query: params.toString(),
          ...(consent ? { accept } : {}),
        }),
      })
      const body = await response.json()
      if (!response.ok)
        throw new Error(
          body.error?.message ?? "Could not authorize this connection."
        )
      const destination = new URL(body.data.url, window.location.origin)
      if (
        !consent &&
        destination.origin === window.location.origin &&
        destination.pathname === "/mcp/consent"
      )
        destination.searchParams.set("datool_project", projectId)
      window.location.assign(destination.href)
    } catch (error) {
      setError(error instanceof Error ? error.message : "Connection failed.")
      setBusy(false)
    }
  }
  const selected = projects.find((project) => project.id === projectId)
  return (
    <main className="min-h-screen bg-background px-6 py-16 text-foreground">
      <section className="mx-auto max-w-lg space-y-6 rounded-xl border border-border bg-card p-8">
        <div>
          <p className="text-sm text-muted-foreground">
            Datool · MCP connection
          </p>
          <h1 className="mt-2 text-2xl font-semibold">
            {consent
              ? `Allow ${clientName} to access your project?`
              : "Choose a project"}
          </h1>
        </div>
        {consent ? (
          <p>
            <strong>{selected?.organizationName}</strong> /{" "}
            {selected?.name ?? "Select a project first"}
          </p>
        ) : (
          <label className="block space-y-2">
            <span>Organization / project</span>
            <select
              className="w-full rounded-md border bg-background p-3"
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Select a project</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.organizationName} / {project.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <div>
          <p className="mb-2 text-sm text-muted-foreground">Requested access</p>
          <ul className="space-y-1 text-sm">
            {requested
              .filter((scope) =>
                (mcpScopes as readonly string[]).includes(scope)
              )
              .map((scope) => (
                <li key={scope}>{scope.replace(":", ": ")}</li>
              ))}
            {requested.includes("offline_access") && (
              <li>Keep the connection active with refresh tokens</li>
            )}
          </ul>
        </div>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        {ready && projects.length === 0 && (
          <p>
            Create an organization and project in{" "}
            <Link className="underline" href="/">
              your workspace
            </Link>
            , then reconnect.
          </p>
        )}
        <div className="flex gap-3">
          <button
            className="rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            disabled={busy || !selected}
            onClick={() => void submit(true)}
          >
            {busy ? "Connecting…" : consent ? "Allow access" : "Continue"}
          </button>
          {consent && (
            <button
              className="rounded-md border px-4 py-2"
              disabled={busy || !selected}
              onClick={() => void submit(false)}
            >
              Deny
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Access applies to this project and is limited by your organization
          role. You can revoke the connection from your workspace.
        </p>
      </section>
    </main>
  )
}
