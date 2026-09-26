"use client"
import { useEffect, useState } from "react"
import { SettingsShell } from "@/components/workspace/settings-shell"
import { Button } from "@/components/ui/button"
type Connection = {
  id: string
  name: string | null
  projectName: string
  scopes: string[]
  createdAt: string
}
export function McpConnections({
  organizationId,
  embedded = false,
}: {
  organizationId: string
  embedded?: boolean
}) {
  const [connections, setConnections] = useState<Connection[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<string>()
  const [loading, setLoading] = useState(true)
  const endpoint = `/api/organizations/${encodeURIComponent(organizationId)}/mcp-connections`
  useEffect(() => {
    let active = true
    void fetch(endpoint)
      .then(async (response) => {
        const body = await response.json()
        if (!response.ok) throw new Error(body.error?.message)
        if (active) setConnections(body.data)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [endpoint])
  return (
    <SettingsShell title="MCP connections" backHref="/" embedded={embedded}>
      <section className="mx-auto w-full max-w-3xl space-y-6 p-4 sm:p-6">
        {!embedded && (
          <h1 className="text-lg font-semibold">MCP connections</h1>
        )}
        <p className="text-sm text-foreground-muted">
          Manage clients you have authorized across this organization. Connect a
          new client using <code>{"/api/mcp"}</code>.
        </p>
        {error && (
          <p role="alert" className="text-destructive">
            {error}
          </p>
        )}
        {loading && <p role="status">Loading connections…</p>}
        {!loading && !error && connections.length === 0 && (
          <p>No authorized connections.</p>
        )}
        {connections.map((connection) => (
          <div
            className="flex items-center justify-between gap-4 rounded-lg border p-4"
            key={connection.id}
          >
            <div>
              <p className="font-medium">
                {connection.name ?? "MCP client"} · {connection.projectName}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {connection.scopes.join(", ")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={async () => {
                setBusy(connection.id)
                setError(undefined)
                try {
                  const response = await fetch(endpoint, {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: connection.id }),
                  })
                  if (!response.ok)
                    throw new Error("Could not revoke connection.")
                  setConnections((current) =>
                    current.filter((item) => item.id !== connection.id)
                  )
                } catch (error) {
                  setError(
                    error instanceof Error
                      ? error.message
                      : "Could not revoke connection."
                  )
                } finally {
                  setBusy(undefined)
                }
              }}
            >
              {busy === connection.id ? "Revoking…" : "Revoke"}
            </Button>
          </div>
        ))}
      </section>
    </SettingsShell>
  )
}
