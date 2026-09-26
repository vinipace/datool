import { Context, Effect, Layer } from "effect"

import { asTracerError, TracerError } from "@/src/server/tracer/errors"
import type { TracerService } from "@/src/server/tracer/service"

/**
 * The service exposes Effect programs and routes run them at the HTTP edge.
 * That keeps database, validation, and evaluator failures typed until the one
 * place where Next needs a JSON response.
 */
export type TracerEffect<A> = Effect.Effect<A, TracerError>

export function tracerEffect<A>(operation: () => Promise<A>): TracerEffect<A> {
  return Effect.tryPromise({
    try: () => operation(),
    catch: (error) => asTracerError(error),
  })
}

export function runTracerEffect<A>(effect: TracerEffect<A>) {
  return Effect.runPromise(effect)
}

/**
 * Route handlers depend on this service key instead of reaching for a module
 * singleton. The local process supplies the live service through a Layer.
 */
export const TracerServiceContext = Context.Service<TracerService>("@datool/TracerService")

export function tracerServiceProgram<A>(
  operation: (service: TracerService) => TracerEffect<A>,
) {
  return Effect.flatMap(Effect.service(TracerServiceContext), operation)
}

export function runWithTracerService<A>(
  service: TracerService,
  operation: (service: TracerService) => TracerEffect<A>,
) {
  return Effect.runPromise(
    Effect.provide(
      tracerServiceProgram(operation),
      Layer.succeed(TracerServiceContext, service),
    ),
  )
}
