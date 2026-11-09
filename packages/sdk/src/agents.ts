/** Server-side application SDK. Never expose an API key to a browser. */
import { Buffer } from "node:buffer"

export type AgentScope = {
  connectionId: string
  userId: string
  drive?: string
  threadId?: string
}
export type DatoolClientOptions = {
  apiKey: string
  projectId: string
  baseUrl?: string
  fetch?: typeof fetch
}
export type ChatMessage = {
  id: string
  role: "user" | "assistant"
  text: string
  createdAt: string
}
export type ChatMessages = {
  conversationId: string
  messages: ChatMessage[]
  nextCursor: string | null
  pending: boolean
  failed: boolean
}
export type TaskDefinition = {
  name: string
  prompt: string
  schedule: { kind: "once"; at: string } | { kind: "cron"; expression: string }
  timezone: string
  enabled?: boolean
}
export type AgentTask = Omit<TaskDefinition, "enabled"> & {
  id: string
  revision: number
  status: "active" | "paused" | "completed"
  nextRunAt: string | null
}
export type TaskRun = {
  id: string
  taskId: string
  status: string
  conversationId: string | null
  error: string | null
  scheduledAt: string
}
export type Page<T> = { items: T[]; nextCursor: string | null }
export type FileEntry = {
  name: string
  type: "file" | "directory" | "symlink"
  size: number
}
export type ChatRequest =
  | { action: "session"; threadId?: string }
  | { action: "messages"; conversationId: string; before?: string }
  | { action: "send"; conversationId: string; text: string; requestId: string }
export type SendResult = {
  conversationId: string
  status: string
  text: string
}

export class DatoolError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message)
    this.name = "DatoolError"
  }
}

export function createDatoolClient(options: DatoolClientOptions) {
  if (typeof window !== "undefined")
    throw new Error("The Datool agent SDK belongs on your server.")
  if (!options.apiKey?.trim() || !options.projectId?.trim())
    throw new Error("Datool apiKey and projectId are required.")
  const base = new URL(options.baseUrl ?? "https://www.trydatool.com")
  if (
    base.username ||
    base.password ||
    (base.protocol !== "https:" &&
      !(
        base.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
      ))
  )
    throw new Error(
      "Use an HTTPS Datool URL, or HTTP on localhost for development."
    )
  const transport = options.fetch ?? fetch
  async function call<T>(
    operation: string,
    input: unknown,
    requestId = crypto.randomUUID()
  ): Promise<T> {
    const response = await transport(new URL(`/api/build/${operation}`, base), {
      method: "POST",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
        "x-project-id": options.projectId,
        "idempotency-key": requestId,
      },
      body: JSON.stringify(input),
    })
    const body = (await response.json()) as {
      data?: T
      error?: { message?: string; code?: string }
    }
    if (!response.ok)
      throw new DatoolError(
        body.error?.message ?? "Datool request failed.",
        response.status,
        body.error?.code
      )
    return body.data as T
  }
  return {
    agent(scope: AgentScope) {
      const { threadId = "default", ...identity } = scope
      let session: Promise<{ conversationId: string }> | undefined
      const connect = () =>
        (session ??= call<{ conversationId: string }>("build_sdk_chat", {
          ...identity,
          request: { action: "session", threadId },
        }).catch((error) => {
          session = undefined
          throw error
        }))
      const chat = <T>(request: ChatRequest) =>
        call<T>(
          "build_sdk_chat",
          { ...identity, request },
          request.action === "send" ? request.requestId : undefined
        )
      const file = <T>(request: Record<string, unknown>) =>
        call<T>("build_sdk_files", { ...identity, request })
      const task = async <T>(
        request: Record<string, unknown>,
        requestId?: string
      ) =>
        call<T>(
          "build_sdk_tasks",
          { ...identity, ...(await connect()), request },
          requestId
        )
      const taskDefinition = (value: AgentTask): TaskDefinition => ({
        name: value.name,
        prompt: value.prompt,
        schedule: value.schedule,
        timezone: value.timezone,
        enabled: value.status === "active",
      })
      return {
        connect,
        /** For the authenticated React route adapter; scope always comes from server code. */
        chat,
        messages: {
          list: async (options: { before?: string } = {}) =>
            chat<ChatMessages>({
              action: "messages",
              ...(await connect()),
              ...options,
            }),
          send: async (text: string, options: { requestId?: string } = {}) =>
            chat<SendResult>({
              action: "send",
              ...(await connect()),
              text,
              requestId: options.requestId ?? crypto.randomUUID(),
            }),
        },
        files: {
          list: async (path = "") =>
            (await file<{ entries: FileEntry[] }>({ action: "list", path }))
              .entries,
          read: async (path: string) =>
            Buffer.from(
              (await file<{ content: string }>({ action: "read", path }))
                .content,
              "base64"
            ).toString("utf8"),
          readBytes: async (path: string) =>
            new Uint8Array(
              Buffer.from(
                (await file<{ content: string }>({ action: "read", path }))
                  .content,
                "base64"
              )
            ),
          write: (path: string, content: string | Uint8Array) =>
            file<{ written: true; size: number }>({
              action: "write",
              path,
              content: Buffer.from(content).toString("base64"),
            }),
          mkdir: (path: string) =>
            file<{ created: true }>({ action: "mkdir", path }),
          delete: (path: string) =>
            file<{ deleted: true }>({ action: "delete", path }),
        },
        tasks: {
          list: (options: { cursor?: string; limit?: number } = {}) =>
            task<Page<AgentTask>>({ action: "list", ...options }),
          create: (
            definition: TaskDefinition,
            options: { requestId?: string } = {}
          ) =>
            task<AgentTask>(
              { action: "create", task: definition },
              options.requestId
            ),
          update: (current: AgentTask, changes: Partial<TaskDefinition>) =>
            task<AgentTask>({
              action: "update",
              id: current.id,
              expectedRevision: current.revision,
              task: { ...taskDefinition(current), ...changes },
            }),
          pause: (current: Pick<AgentTask, "id" | "revision">) =>
            task<AgentTask>({
              action: "pause",
              id: current.id,
              expectedRevision: current.revision,
            }),
          resume: (current: Pick<AgentTask, "id" | "revision">) =>
            task<AgentTask>({
              action: "resume",
              id: current.id,
              expectedRevision: current.revision,
            }),
          delete: (current: Pick<AgentTask, "id" | "revision">) =>
            task<{ deleted: true }>({
              action: "delete",
              id: current.id,
              expectedRevision: current.revision,
            }),
          runNow: (id: string, options: { requestId?: string } = {}) =>
            task<TaskRun>({ action: "run", id }, options.requestId),
          runs: (
            id: string,
            options: { cursor?: string; limit?: number } = {}
          ) => task<Page<TaskRun>>({ action: "runs", id, ...options }),
        },
      }
    },
  }
}
export type DatoolAgent = ReturnType<
  ReturnType<typeof createDatoolClient>["agent"]
>
