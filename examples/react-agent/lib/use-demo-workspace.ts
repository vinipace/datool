"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { AgentTask, FileEntry } from "@datool/sdk/agents"
import type { Workspace } from "./datool"

async function fetchData(
  controller: AbortController,
  body?: Record<string, unknown>
) {
  const response = await fetch("/api/demo", {
    method: body ? "POST" : "GET",
    cache: "no-store",
    signal: controller.signal,
    ...(body && {
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error)
  return data
}

export function useDemoWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>("acme")
  const [ready, setReady] = useState(false)
  const [context, setContext] = useState("")
  const [savedContext, setSavedContext] = useState("")
  const [tasks, setTasks] = useState<AgentTask[]>([])
  const [files, setFiles] = useState<FileEntry[] | null>(null)
  const [pending, setPending] = useState(true)
  const [notice, setNotice] = useState("")
  const [error, setError] = useState("")
  const activeWorkspace = useRef<Workspace | null>(null)
  const request = useRef<AbortController | null>(null)

  const applyWorkspace = useCallback(
    (data: { workspace: Workspace; content: string; tasks: AgentTask[] }) => {
      activeWorkspace.current = data.workspace
      setWorkspace(data.workspace)
      setContext(data.content)
      setSavedContext(data.content)
      setTasks(data.tasks)
      setReady(true)
    },
    []
  )

  const action = useCallback(
    async (input: Record<string, unknown>) => {
      const polling = input.action === "poll"
      if (polling && (!activeWorkspace.current || request.current)) return
      request.current?.abort()
      const controller = new AbortController()
      request.current = controller
      const current = () => !controller.signal.aborted
      async function loadWorkspace() {
        const data = await fetchData(controller, { action: "load" })
        if (current()) applyWorkspace(data)
      }
      const clearWorkspace = () => {
        activeWorkspace.current = null
        setReady(false)
        setContext("")
        setSavedContext("")
        setTasks([])
        setFiles(null)
      }
      if (!polling) {
        setPending(true)
        setNotice("")
        setError("")
      }
      try {
        if (input.action === "load" || input.action === "workspace") {
          // Remove the old chat before changing the server's session cookie.
          clearWorkspace()
          if (input.action === "workspace") {
            setWorkspace(input.workspace as Workspace)
            await fetchData(controller, input)
          }
          if (current()) await loadWorkspace()
          return
        }
        if (!polling) {
          const data = await fetchData(controller, {
            ...input,
            expectedWorkspace: activeWorkspace.current,
          })
          if (!current()) return
          if (typeof data.content === "string") {
            setContext(data.content)
            setSavedContext(data.content)
          }
          if (input.action === "save") setSavedContext(input.content as string)
          if (data.files) setFiles(data.files)
          setNotice(data.message ?? "File list refreshed.")
        }
        const data = await fetchData(controller)
        if (!current()) return
        if (data.workspace !== activeWorkspace.current) {
          // Also handle a sign-in change in another browser tab.
          clearWorkspace()
          await loadWorkspace()
        } else {
          // Task polling must not replace an unsaved editor draft.
          setTasks(data.tasks)
        }
      } catch (reason) {
        if (current())
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not load this workspace."
          )
      } finally {
        if (current()) {
          request.current = null
          setPending(false)
        }
      }
    },
    [applyWorkspace]
  )

  useEffect(() => {
    const controller = new AbortController()
    request.current = controller
    void fetchData(controller, { action: "load" })
      .then((data) => {
        if (!controller.signal.aborted) applyWorkspace(data)
      })
      .catch((reason: Error) => {
        if (!controller.signal.aborted) setError(reason.message)
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          request.current = null
          setPending(false)
        }
      })
    const timer = setInterval(() => void action({ action: "poll" }), 5000)
    return () => {
      clearInterval(timer)
      request.current?.abort()
    }
  }, [action, applyWorkspace])

  return {
    workspace,
    ready,
    context,
    setContext,
    savedContext,
    tasks,
    files,
    pending,
    notice,
    error,
    action,
  }
}
