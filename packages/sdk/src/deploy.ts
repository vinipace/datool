/** Runtime capabilities injected into deployed tools and source collectors. */
export type ProjectContext = {
  /** Transport used by the generated typed PostgreSQL client. */
  query(
    sql: string,
    params: unknown[],
    method: "all" | "execute"
  ): Promise<{ rows: unknown[] }>
  db: {
    get<T = unknown>(
      collection: string,
      key: string
    ): Promise<{ value: T; revision: number } | null>
    /** expectedRevision=0 inserts only; a positive revision performs compare-and-set. */
    set(
      collection: string,
      key: string,
      value: unknown,
      expectedRevision?: number
    ): Promise<{ revision: number }>
    delete(
      collection: string,
      key: string,
      expectedRevision?: number
    ): Promise<{ deleted: boolean }>
    list<T = unknown>(
      collection: string,
      options?: {
        cursor?: string
        limit?: number
        where?: Record<string, unknown>
      }
    ): Promise<{
      items: { key: string; value: T; revision: number }[]
      nextCursor: string | null
    }>
  }
  bucket: {
    get(
      key: string
    ): Promise<{ data: Uint8Array; contentType: string; size: number } | null>
    put(
      key: string,
      data: string | Uint8Array,
      contentType?: string
    ): Promise<{ key: string; size: number }>
    delete(key: string): Promise<{ deleted: boolean }>
    list(options?: {
      prefix?: string
      cursor?: string
      limit?: number
    }): Promise<{
      items: { key: string; size: number; contentType: string }[]
      nextCursor: string | null
    }>
  }
  sandbox: {
    run(
      command: string,
      options?: { timeoutSeconds?: number }
    ): Promise<{
      stdout: string
      stderr: string
      exitCode: number
      truncated: boolean
    }>
  }
  brain: {
    search(
      query: string,
      limit?: number
    ): Promise<{ items: { path: string; title: string; text: string }[] }>
  }
  fetch(
    url: string,
    options?: {
      method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
      headers?: Record<string, string>
      body?: string
    }
  ): Promise<Response>
}
export type ProjectTool<Input = Record<string, unknown>, Output = unknown> = {
  description: string
  inputSchema: Record<string, unknown>
  execute(input: Input, context: ProjectContext): Output | Promise<Output>
}
export type ProjectSource = { path: string; title: string; text: string }
export type ProjectSourceCollector = (
  context: ProjectContext
) => ProjectSource[] | Promise<ProjectSource[]>
export function defineTool<Input, Output>(tool: ProjectTool<Input, Output>) {
  return tool
}

/** The generated client owns its database instance so schema and query types match. */
export function createProject<Database>(
  createDatabase: (context: ProjectContext) => Database
) {
  type Context = ProjectContext & { sql: Database }
  const context = (ctx: ProjectContext): Context => ({
    ...ctx,
    sql: createDatabase(ctx),
  })
  return {
    defineTool<Input, Output>(
      tool: Omit<ProjectTool<Input, Output>, "execute"> & {
        execute(input: Input, ctx: Context): Output | Promise<Output>
      }
    ): ProjectTool<Input, Output> {
      return {
        ...tool,
        execute: (input, ctx) => tool.execute(input, context(ctx)),
      }
    },
    defineSource(
      collector: (ctx: Context) => ProjectSource[] | Promise<ProjectSource[]>
    ): ProjectSourceCollector {
      return (ctx) => collector(context(ctx))
    },
  }
}
