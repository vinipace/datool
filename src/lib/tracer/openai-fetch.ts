/** Instrument non-streaming Chat Completions (including Autoevals judges).
 * The wrapper captures each HTTP attempt and preserves the original Response.
 * AI SDK calls already emit OTel spans and should not use this wrapper too.
 */
type TraceSpan = {
  setAttribute(key: string, value: string | number | boolean): unknown
  setStatus(status: { code: number; message?: string }): unknown
  end(): void
}
type Tracer = {
  startActiveSpan<T>(
    name: string,
    options: { attributes: Record<string, string> },
    work: (span: TraceSpan) => Promise<T>
  ): Promise<T>
}

export function traceOpenAIChatFetch(
  tracer: Tracer,
  fetchImpl: typeof fetch = globalThis.fetch
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url
    )
    if (!url.pathname.endsWith("/chat/completions"))
      return fetchImpl(input, init)
    const raw =
      typeof init?.body === "string"
        ? init.body
        : input instanceof Request
          ? await input.clone().text()
          : null
    let body: Record<string, unknown>
    try {
      body = JSON.parse(raw ?? "{}")
    } catch {
      return fetchImpl(input, init)
    }
    if (body.stream) return fetchImpl(input, init)
    return tracer.startActiveSpan(
      "openai.chat.completions",
      {
        attributes: {
          "datool.span.kind": "llm",
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": "openai",
          ...(typeof body.model === "string"
            ? { "gen_ai.request.model": body.model }
            : {}),
          input: JSON.stringify(body.messages ?? []),
        },
      },
      async (span) => {
        try {
          const response = await fetchImpl(input, init)
          span.setAttribute("http.response.status_code", response.status)
          if (!response.ok) {
            span.setStatus({
              code: 2,
              message: `OpenAI HTTP ${response.status}`,
            })
            return response
          }
          const result = await response.clone().json()
          if (typeof result.model === "string")
            span.setAttribute("gen_ai.response.model", result.model)
          if (typeof result.id === "string")
            span.setAttribute("gen_ai.response.id", result.id)
          span.setAttribute(
            "output",
            JSON.stringify(
              result.choices?.map(
                (choice: { message: unknown }) => choice.message
              ) ?? []
            )
          )
          const usage = result.usage
          if (usage) {
            span.setAttribute("openai.usage", JSON.stringify(usage))
            for (const [key, value] of Object.entries({
              "gen_ai.usage.input_tokens": usage.prompt_tokens,
              "gen_ai.usage.output_tokens": usage.completion_tokens,
              "ai.usage.totalTokens": usage.total_tokens,
              "gen_ai.usage.cache_read.input_tokens":
                usage.prompt_tokens_details?.cached_tokens,
              "gen_ai.usage.reasoning.output_tokens":
                usage.completion_tokens_details?.reasoning_tokens,
            })) {
              if (typeof value === "number") span.setAttribute(key, value)
            }
          }
          return response
        } catch (error) {
          span.setStatus({
            code: 2,
            message:
              error instanceof Error ? error.message : "OpenAI request failed",
          })
          throw error
        } finally {
          span.end()
        }
      }
    )
  }
}
