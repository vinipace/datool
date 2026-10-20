import { randomUUID } from "node:crypto"
import { OpenTelemetry } from "@ai-sdk/otel"
import {
  AlwaysOnSampler,
  NodeTracerProvider,
} from "@opentelemetry/sdk-trace-node"
import {
  DatoolSpanProcessor,
  type DatoolSpanProcessorOptions,
} from "@/src/lib/tracer/otel"
import { applyEvent } from "@/src/server/ingestion/events"
import { runTracerEffect } from "./effect"
import type { TracerService } from "./service"

/** Request-local telemetry: no global provider registration or HTTP loopback. */
export function createAiTelemetry(options: {
  service: TracerService
  traceId: string
  signal?: AbortSignal
  transform?: DatoolSpanProcessorOptions["transform"]
}) {
  const processor = new DatoolSpanProcessor({
    invocationTraceId: options.traceId,
    transform: options.transform,
    transport: {
      request: (path, method, body) =>
        runTracerEffect<unknown>(
          applyEvent(options.service, {
            id: randomUUID(),
            previousId: null,
            path,
            method,
            body,
          })
        ),
      forceFlush: async () => {},
    },
  })
  const provider = new NodeTracerProvider({
    sampler: new AlwaysOnSampler(),
    spanProcessors: [
      {
        onStart: (span) => processor.onStart(span),
        onEnd: (span) =>
          processor.onEnd({
            name: span.name,
            attributes: {
              ...span.attributes,
              ...(options.signal?.aborted
                ? { "datool.span.cancelled": true }
                : {}),
            },
            status: options.signal?.aborted ? { code: 0 } : span.status,
            startTime: span.startTime,
            endTime: span.endTime,
            parentSpanContext: span.parentSpanContext,
            spanContext: () => span.spanContext(),
            events: span.events,
            resource: span.resource,
          }),
        forceFlush: () => processor.forceFlush(),
        shutdown: () => processor.shutdown(),
      },
    ],
  })
  return {
    integration: new OpenTelemetry({ tracer: provider.getTracer("datool.ai") }),
    shutdown: () => provider.shutdown(),
  }
}
