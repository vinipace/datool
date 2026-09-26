import { randomUUID } from "node:crypto"

import { Context, Effect, Layer } from "effect"

import type { SemanticCatalog, SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import type { SemanticResult } from "@/src/lib/semantic/result"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { executeSemanticQuery, executeSemanticBatch } from "@/src/server/semantic/executor"
import {
  toSemanticServiceError,
  type SemanticServiceError,
} from "@/src/server/semantic/errors"
import {
  createSemanticSnapshotRunner,
  type SemanticSnapshotRunner,
} from "@/src/server/semantic/snapshot"

export type SemanticQueryServiceOptions = Readonly<{
  catalog: SemanticCatalog
  database: TracerDatabase
  now?: () => Date
  requestId?: () => string
  snapshotRunner?: SemanticSnapshotRunner
}>

/**
 * The one Effect-facing boundary for metadata discovery and bounded execution.
 * Pure query/catalog code stays transport-neutral; this service owns runtime
 * clock, request identity, database snapshot, and typed failure conversion.
 */
export class SemanticQueryService {
  private readonly catalog: SemanticCatalog
  private readonly now: () => Date
  private readonly requestId: () => string
  private readonly snapshotRunner: SemanticSnapshotRunner

  constructor(options: SemanticQueryServiceOptions) {
    this.catalog = options.catalog
    this.now = options.now ?? (() => new Date())
    this.requestId = options.requestId ?? (() => `sem_${randomUUID().replaceAll("-", "")}`)
    this.snapshotRunner = options.snapshotRunner ?? createSemanticSnapshotRunner(options.database)
  }

  metadata(): Effect.Effect<SemanticCatalogMetadata> {
    return Effect.sync(() => this.catalog.metadata())
  }

  batch(input: unknown): Effect.Effect<SemanticResult[], SemanticServiceError> {
    return Effect.tryPromise({
      try: () => executeSemanticBatch(input, { catalog: this.catalog, now: this.now, requestId: this.requestId(), snapshotRunner: this.snapshotRunner }),
      catch: toSemanticServiceError,
    })
  }

  query(input: unknown): Effect.Effect<SemanticResult, SemanticServiceError> {
    return Effect.tryPromise({
      try: () =>
        executeSemanticQuery(input, {
          catalog: this.catalog,
          now: this.now,
          requestId: this.requestId(),
          snapshotRunner: this.snapshotRunner,
        }),
      catch: toSemanticServiceError,
    })
  }
}

export function createSemanticQueryService(options: SemanticQueryServiceOptions) {
  return new SemanticQueryService(options)
}

export const SemanticQueryServiceContext = Context.Service<SemanticQueryService>("@datool/SemanticQueryService")

export function semanticQueryServiceLayer(service: SemanticQueryService) {
  return Layer.succeed(SemanticQueryServiceContext, service)
}

export function semanticQueryProgram(input: unknown) {
  return Effect.flatMap(Effect.service(SemanticQueryServiceContext), (service) => service.query(input))
}

export function semanticMetadataProgram() {
  return Effect.flatMap(Effect.service(SemanticQueryServiceContext), (service) => service.metadata())
}

export function runWithSemanticQueryService<Value>(
  service: SemanticQueryService,
  program: Effect.Effect<Value, SemanticServiceError, SemanticQueryService>,
) {
  return Effect.runPromise(Effect.provide(program, semanticQueryServiceLayer(service)))
}
