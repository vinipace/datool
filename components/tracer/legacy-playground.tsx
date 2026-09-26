"use client"
import { projectFetch } from "@/lib/workspace-routing"

import { useEffect, useState } from "react"
import { PlaygroundTraces } from "./playground-traces"
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable"
import { Button } from "@/components/ui/button"

type App = { id: string; name: string; mode: "agent" | "input"; url: string }
type Message = { role: "user" | "assistant"; content: string }
async function request(path: string, body?: unknown) {
  const response = await projectFetch(
    path,
    body === undefined
      ? undefined
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
  )
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message ?? "Request failed")
  return result.data
}
export function LegacyPlayground() {
  const [apps, setApps] = useState<App[]>([])
  const [selected, setSelected] = useState("")
  const [name, setName] = useState("")
  const [url, setUrl] = useState("")
  const [token, setToken] = useState("")
  const [mode, setMode] = useState<"agent" | "input">("input")
  const [input, setInput] = useState("{}")
  const [messages, setMessages] = useState<Message[]>([])
  const [output, setOutput] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const app = apps.find((item) => item.id === selected)
  useEffect(() => {
    request("/api/apps")
      .then(setApps)
      .catch((error) => setError(error.message))
  }, [])
  async function save() {
    setBusy(true)
    setError("")
    try {
      const saved: App = await request("/api/apps", {
        name,
        url,
        mode,
        token: token || undefined,
      })
      setApps((items) => [
        ...items.filter((item) => item.id !== saved.id),
        saved,
      ])
      choose(saved.id)
      setToken("")
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  function choose(id: string) {
    setSelected(id)
    setMessages([])
    setOutput("")
    setInput("")
    setError("")
  }
  async function run() {
    if (!app) return
    setBusy(true)
    setError("")
    try {
      const next: Message[] = [...messages, { role: "user", content: input }]
      const result = await request(
        `/api/apps/${app.id}/call`,
        app.mode === "agent" ? { messages: next } : { input: JSON.parse(input) }
      )
      const rendered =
        typeof result === "string" ? result : JSON.stringify(result, null, 2)
      setOutput(rendered)
      if (app.mode === "agent") {
        setMessages([
          ...next,
          {
            role: "assistant",
            content:
              typeof result?.content === "string" ? result.content : rendered,
          },
        ])
        setInput("")
      }
    } catch (error) {
      setError((error as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const field = "rounded-md border border-border bg-background p-2 text-sm"
  return (
    <main className="h-[calc(100dvh-2.75rem)] min-h-0 overflow-hidden bg-background">
      <ResizablePanelGroup orientation="vertical" id="playground-layout">
        <ResizablePanel id="playground-call" defaultSize="60%" minSize="20%">
          <div className="h-full overflow-y-auto">
            <div className="mx-auto grid max-w-6xl gap-8 p-6 md:grid-cols-[280px_1fr]">
              <aside className="space-y-4">
                <h1 className="text-lg font-semibold">Playground</h1>
                <label className="grid gap-2 text-sm">
                  App
                  <select
                    className={field}
                    disabled={busy}
                    value={selected}
                    onChange={(event) => choose(event.target.value)}
                  >
                    <option value="">Select an app</option>
                    {apps.map((app) => (
                      <option key={app.id} value={app.id}>
                        {app.name} · {app.mode}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    request("/api/apps")
                      .then(setApps)
                      .catch((error) => setError(error.message))
                  }
                >
                  Refresh apps
                </Button>
                <form
                  className="space-y-3 border-t pt-5"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void save()
                  }}
                >
                  <h2 className="font-medium">Add app</h2>
                  <input
                    className={`${field} w-full`}
                    aria-label="App name"
                    placeholder="App name"
                    required
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  <select
                    aria-label="App mode"
                    className={`${field} w-full`}
                    value={mode}
                    onChange={(event) =>
                      setMode(event.target.value as typeof mode)
                    }
                  >
                    <option value="input">JSON input</option>
                    <option value="agent">Agent messages</option>
                  </select>
                  <input
                    className={`${field} w-full`}
                    aria-label="HTTP endpoint"
                    type="url"
                    placeholder="https://example.com/call"
                    required
                    value={url}
                    onChange={(event) => setUrl(event.target.value)}
                  />
                  <input
                    className={`${field} w-full`}
                    aria-label="Bearer token"
                    type="password"
                    placeholder="Bearer token (optional)"
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                  />
                  <Button type="submit" disabled={busy}>
                    Add app
                  </Button>
                </form>
                <p className="text-sm text-muted-foreground">
                  Or connect a local handler:
                </p>
                <code className="block text-xs break-all">
                  datool connect local.ts --mode agent
                </code>
              </aside>
              <section className="min-w-0 space-y-4">
                {!app ? (
                  <p className="py-12 text-muted-foreground">
                    Add or select an app to start calling it.
                  </p>
                ) : (
                  <>
                    <div className="flex items-center justify-between">
                      <h2 className="font-medium">{app.name}</h2>
                      <Button
                        variant="ghost"
                        disabled={busy}
                        onClick={() => choose(app.id)}
                      >
                        Reset
                      </Button>
                    </div>
                    {messages.map((message, index) => (
                      <div key={index} className="rounded-md border p-3">
                        <p className="mb-2 text-xs font-medium text-muted-foreground uppercase">
                          {message.role}
                        </p>
                        <pre className="text-sm whitespace-pre-wrap">
                          {message.content}
                        </pre>
                      </div>
                    ))}
                    <form
                      className="space-y-3"
                      onSubmit={(event) => {
                        event.preventDefault()
                        void run()
                      }}
                    >
                      <label className="grid gap-2 text-sm">
                        {app.mode === "agent" ? "Message" : "JSON input"}
                        <textarea
                          className={`${field} min-h-36 font-mono`}
                          required
                          disabled={busy}
                          value={input}
                          onChange={(event) => setInput(event.target.value)}
                          placeholder={
                            app.mode === "agent"
                              ? "Send a message…"
                              : '{"prompt": "Hello"}'
                          }
                        />
                      </label>
                      <Button type="submit" disabled={busy}>
                        {busy
                          ? "Calling…"
                          : app.mode === "agent"
                            ? "Send"
                            : "Run"}
                      </Button>
                    </form>
                    {app.mode === "input" && output && (
                      <div>
                        <h3 className="mb-2 text-sm font-medium">Output</h3>
                        <pre className="overflow-auto rounded-md border p-4 text-sm whitespace-pre-wrap">
                          {output}
                        </pre>
                      </div>
                    )}
                  </>
                )}
                {error && (
                  <p role="alert" className="text-sm text-destructive">
                    {error}
                  </p>
                )}
              </section>
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle withHandle aria-label="Resize traces pane" />
        <ResizablePanel id="playground-traces" defaultSize="40%" minSize="20%">
          {app ? (
            <PlaygroundTraces key={app.id} connectionId={app.id} />
          ) : (
            <section className="flex h-full flex-col" aria-label="App traces">
              <h2 className="shrink-0 border-b px-4 py-3 text-sm font-medium">
                Traces
              </h2>
              <p className="overflow-auto p-4 text-sm text-muted-foreground">
                Select an app to view its traces.
              </p>
            </section>
          )}
        </ResizablePanel>
      </ResizablePanelGroup>
    </main>
  )
}
