import type { ExplorerHost } from "./host"
import type { TraceReadApi } from "@/components/tracer/trace-data-context"
import type { ApiList, TraceScore } from "@/src/lib/tracer/contracts"

/** The inspector's existing read contract, transported through its authorized host. */
export function createMcpTraceReadApi(host: ExplorerHost): TraceReadApi {
  async function read<T>(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    signal?.throwIfAborted()
    const data = await host.call<T>(name, args)
    signal?.throwIfAborted()
    return data
  }
  return {
    overview: (id, signal, includeRootDetail) =>
      read(
        "get_trace_overview",
        { id, includeRootDetail: includeRootDetail ?? false },
        signal
      ),
    payload: (id, signal) => read("get_trace_payload", { id }, signal),
    span: (traceId, spanId, signal) =>
      read("get_trace_span", { traceId, spanId }, signal),
    spans: (id, options = {}) =>
      read(
        "list_trace_spans",
        {
          id,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          limit: Math.min(options.limit ?? 100, 100),
        },
        options.signal
      ),
    scores: async (id, options = {}) => {
      const page = await read<ApiList<TraceScore>>(
        "list_trace_scores",
        {
          id,
          ...(options.cursor ? { cursor: options.cursor } : {}),
          limit: Math.min(options.limit ?? 100, 100),
        },
        options.signal
      )
      return {
        ...page,
        items: page.items.map((score, index) => ({
          ...score,
          id: score.evalResultId ?? `${options.cursor ?? "first"}:${index}`,
        })),
      }
    },
  }
}
