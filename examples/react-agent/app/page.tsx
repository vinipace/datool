"use client"
import { useCallback, useEffect, useState } from "react"
import { DatoolChat } from "@datool/react"
import type { AgentTask, FileEntry } from "@datool/sdk/agents"

const starter = `# Company context\n\nAcme Studio builds software for independent teams.\nOur priority this week is launching the customer portal.\n\n## Current work\n- Finish onboarding and invite the first 10 customers.\n- Collect feedback from the pilot group.\n- Prepare a short weekly progress update.\n`
export default function Page() {
  const [workspace, setWorkspace] = useState("acme")
  const [ready, setReady] = useState(false)
  const [context, setContext] = useState(starter)
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [pending, setPending] = useState(false)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const [tab, setTab] = useState<"context" | "tasks">("context")
  const refresh = useCallback(async () => {
    const response = await fetch("/api/demo", { cache: "no-store" })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error)
    setWorkspace(data.workspace)
    setTasks(data.tasks)
    setReady(true)
  }, [])
  useEffect(() => {
    let active = true
    const load = () => {
      if (active)
        void refresh().catch((reason) => {
          if (active) setError(reason.message)
        })
    }
    load()
    const timer = setInterval(load, 5000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [refresh])
  async function action(input: Record<string, unknown>) {
    setPending(true)
    setNotice("")
    setError("")
    try {
      const response = await fetch("/api/demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error)
      if (typeof data.content === "string") setContext(data.content)
      if (data.files) setFiles(data.files)
      if (input.action === "workspace") {
        setContext("")
        setFiles(null)
        setReady(false)
      }
      setNotice(
        data.message ??
          "Workspace switched. This workspace has its own files and chat."
      )
      await refresh()
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not complete that action."
      )
    } finally {
      setPending(false)
    }
  }
  return (
    <main className="workspace">
      <header className="topbar">
        <a className="brand" href="/">
          <span className="brand-mark">d</span> datool{" "}
          <span className="brand-divider" />{" "}
          <span className="brand-caption">React SDK playground</span>
        </a>
        <span className="local-badge">
          <i /> Local demo
        </span>
      </header>
      <section className="page-heading">
        <div>
          <p className="eyebrow">YOUR APP, WITH AN AGENT</p>
          <h1>A teammate that follows through.</h1>
          <p>
            Give it context. Start a conversation. Let it work on a schedule.
          </p>
        </div>
        <label className="workspace-picker">
          Demo workspace
          <select
            value={workspace}
            disabled={pending}
            onChange={(e) =>
              void action({ action: "workspace", workspace: e.target.value })
            }
          >
            <option value="acme">Acme Studio</option>
            <option value="orbit">Orbit Labs</option>
          </select>
          <small>Simulated sign-in · separate drives & chats</small>
        </label>
      </section>
      <div className="workspace-grid">
        <section className="workbench" aria-label="Agent context and schedules">
          <div className="panel-heading">
            <div>
              <span className="section-number">01</span>
              <h2>Set it up to succeed</h2>
            </div>
            <span className="server-label">Server SDK</span>
          </div>
          <div className="tabs" role="tablist" aria-label="Workspace tools">
            <button
              role="tab"
              aria-selected={tab === "context"}
              onClick={() => setTab("context")}
            >
              Drive & context
            </button>
            <button
              role="tab"
              aria-selected={tab === "tasks"}
              onClick={() => setTab("tasks")}
            >
              Scheduled tasks <span>{tasks.length}</span>
            </button>
          </div>
          {tab === "context" ? (
            <div className="panel-body" role="tabpanel">
              <div className="section-intro">
                <h3>The context your agent works with</h3>
                <p>
                  Save a file to the drive. Your assistant can read it during
                  chat and scheduled runs.
                </p>
              </div>
              <label className="file-label" htmlFor="context">
                <span>context/company.md</span>
                <span>Markdown</span>
              </label>
              <textarea
                id="context"
                className="context-editor"
                value={context}
                onChange={(e) => setContext(e.target.value)}
                maxLength={20_000}
                spellCheck={false}
              />
              <div className="button-row">
                <button
                  className="primary"
                  disabled={pending || !ready}
                  onClick={() =>
                    void action({ action: "save", content: context })
                  }
                >
                  Save to drive <span>↗</span>
                </button>
                <button
                  disabled={pending || !ready}
                  onClick={() => void action({ action: "read" })}
                >
                  Load saved file
                </button>
                <button
                  disabled={pending || !ready}
                  onClick={() => void action({ action: "list" })}
                >
                  List files
                </button>
              </div>
              {files && (
                <ul className="file-list">
                  {files.length ? (
                    files.map((file) => (
                      <li key={file.name}>
                        <span>{file.name}</span>
                        <span>{file.size} bytes</span>
                      </li>
                    ))
                  ) : (
                    <li>No files in this folder.</li>
                  )}
                </ul>
              )}
              <div className="next-step">
                <span>Try this in chat</span>
                <p>“Read our company context and help me plan this week.”</p>
              </div>
            </div>
          ) : (
            <div className="panel-body" role="tabpanel">
              <div className="section-intro">
                <h3>Useful work, without a prompt</h3>
                <p>
                  Schedule a briefing from the saved context. The reply arrives
                  in this chat, even if you leave and return.
                </p>
              </div>
              <div className="schedule-options">
                <button
                  className="schedule-card"
                  disabled={pending || !ready}
                  onClick={() =>
                    void action({ action: "briefing", schedule: "minute" })
                  }
                >
                  <span className="schedule-time">
                    In 1 minute <span>↗</span>
                  </span>
                  <span>A quick way to try a proactive reply</span>
                </button>
                <button
                  className="schedule-card"
                  disabled={pending || !ready}
                  onClick={() =>
                    void action({ action: "briefing", schedule: "daily" })
                  }
                >
                  <span className="schedule-time">
                    Every weekday, 9 AM <span>↗</span>
                  </span>
                  <span>Morning briefing · São Paulo time</span>
                </button>
              </div>
              <div className="task-list">
                {tasks.length === 0 ? (
                  <div className="empty-state">
                    No tasks yet. Schedule your first briefing above.
                  </div>
                ) : (
                  tasks.map((task) => (
                    <article key={task.id} className="task-row">
                      <div>
                        <h4>{task.name}</h4>
                        <p>
                          {task.status}
                          {task.nextRunAt &&
                            ` · ${new Date(task.nextRunAt).toLocaleString()}`}
                        </p>
                      </div>
                      <div className="task-actions">
                        <button
                          disabled={pending}
                          onClick={() =>
                            void action({ action: "run", id: task.id })
                          }
                        >
                          Run now
                        </button>
                        {task.status !== "completed" && (
                          <button
                            disabled={pending}
                            onClick={() =>
                              void action({
                                action:
                                  task.status === "active" ? "pause" : "resume",
                                id: task.id,
                              })
                            }
                          >
                            {task.status === "active" ? "Pause" : "Resume"}
                          </button>
                        )}
                        <button
                          className="quiet"
                          disabled={pending}
                          onClick={() =>
                            void action({ action: "delete", id: task.id })
                          }
                        >
                          Remove
                        </button>
                      </div>
                    </article>
                  ))
                )}
              </div>
            </div>
          )}
          {(notice || error) && (
            <div
              className={error ? "feedback error" : "feedback"}
              role={error ? "alert" : "status"}
            >
              {error || notice}
            </div>
          )}
          <footer className="panel-footer">
            <span className="status-dot" /> API keys stay on the server. Your
            app chooses the drive.
          </footer>
        </section>
        <section className="chat-panel" aria-label="Embedded chat preview">
          <div className="panel-heading">
            <div>
              <span className="section-number">02</span>
              <h2>Work together</h2>
            </div>
            <code>&lt;DatoolChat /&gt;</code>
          </div>
          {ready ? (
            <DatoolChat
              key={workspace}
              endpoint="/api/datool"
              title={
                workspace === "acme" ? "Acme assistant" : "Orbit assistant"
              }
              welcomeMessage="What are we working on today?"
            />
          ) : (
            <div className="chat-loading">Connecting to your agent…</div>
          )}
        </section>
      </div>
      <footer className="page-footer">
        <span>Built with Next.js + Datool</span>
        <span>Chat · Persistent files · Proactive tasks</span>
      </footer>
    </main>
  )
}
