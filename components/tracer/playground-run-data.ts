import { tracerApi } from "./api"
import { readAllTracePages } from "./trace-detail-loader"

/** Never truncate a run to the first collection page or a single trace. */
export async function loadPlaygroundRun(
  traceId: string,
  appId: string,
  signal: AbortSignal
) {
  const invocation = await tracerApi.traces.payload(traceId, signal)
  const callId = invocation.attributes["datool.call.id"]
  if (
    invocation.attributes["datool.connection.id"] !== appId ||
    typeof callId !== "string"
  ) {
    throw new Error("This run does not belong to this app.")
  }
  const summaries = await readAllTracePages(
    (options) =>
      tracerApi.traces.list({
        ...options,
        filter: `metadata."datool.call.id" = ${JSON.stringify(callId)}`,
      }),
    signal
  )
  const ids = [...new Set([traceId, ...summaries.map((trace) => trace.id)])]
  const traces = []
  // Bound simultaneous requests while still reading every trace hierarchy.
  for (let offset = 0; offset < ids.length; offset += 8) {
    signal.throwIfAborted()
    traces.push(
      ...(await Promise.all(
        ids.slice(offset, offset + 8).map(async (id) => {
          // Overview deliberately omits scores. Load their own paginated
          // endpoint so scores arriving after generation appear on refresh.
          const [overview, scores] = await Promise.all([
            tracerApi.traces.overview(id, signal),
            readAllTracePages(
              (options) => tracerApi.traces.scores(id, options),
              signal
            ),
          ])
          return { ...overview, scores }
        })
      ))
    )
  }
  return { invocation, traces }
}
