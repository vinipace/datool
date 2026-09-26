import { validateDatasetItem } from "./dataset-fields"
import { ensureDatasetParents, lockDatasetLibrary } from "./dataset-library"
import { createHash, randomUUID } from "node:crypto"
import { and, eq } from "drizzle-orm"
import {
  resourceDocumentSchema,
  canonicalJson,
  type ResourceDocument,
} from "@/src/lib/tracer/resource-document"
import { getTracerProjectId, scopedTracerTransaction, type TracerDatabase } from "./db"
import { datasets, datasetItems } from "./schema"
import { createScorerService } from "./scorers"
import { runTracerEffect, tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
const hash = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")
export function createResourceService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  const catalog = createScorerService(database)
  async function exportDocument(
    kind: "dataset" | "scorer",
    key: string
  ): Promise<ResourceDocument> {
    if (kind === "scorer") {
      const scorer = (await runTracerEffect(catalog.list())).find(
        (s) => s.slug === key
      )
      if (!scorer) throw notFound("Scorer", key)
      return resourceDocumentSchema.parse({
        format: 1,
        kind,
        key,
        config: scorer,
      })
    }
    const [dataset] = await database
      .select()
      .from(datasets)
      .where(and(eq(datasets.projectId, projectId), eq(datasets.name, key)))
    if (!dataset) throw notFound("Dataset", key)
    const rows = await database
      .select()
      .from(datasetItems)
      .where(and(eq(datasetItems.projectId, projectId), eq(datasetItems.datasetId, dataset.id)))
    return resourceDocumentSchema.parse({
      format: 1,
      kind,
      key,
      description: dataset.description ?? "",
      items: rows
        .map((row) => {
          const metadata = JSON.parse(row.metadataJson)
          const itemKey = metadata["datool.sync.key"] ?? row.id
          delete metadata["datool.sync.key"]
          return {
            key: itemKey,
            input: JSON.parse(row.inputJson),
            expectedOutput: JSON.parse(row.expectedOutputJson ?? "null"),
            metadata,
          }
        })
        .sort((a, b) => a.key.localeCompare(b.key)),
    })
  }
  return {
    export: (kind: "dataset" | "scorer", key: string) =>
      tracerEffect(async () => {
        const document = await exportDocument(kind, key)
        return { document, revision: hash(document) }
      }),
    push: (value: unknown, expectedRevision?: string, dryRun = false) =>
      tracerEffect(async () => {
        const document = resourceDocumentSchema.parse(value)
        if (document.kind === "scorer" && document.key !== document.config.slug)
          throw validation("Scorer key must equal its slug")
        if (document.kind === "dataset") {
          if (
            new Set(document.items.map((i) => i.key)).size !==
            document.items.length
          )
            throw validation("Duplicate dataset item keys")
          document.items.sort((a, b) => a.key.localeCompare(b.key))
        }
        let previous: ResourceDocument | undefined
        try {
          previous = await exportDocument(document.kind, document.key)
        } catch (error) {
          if (!(error instanceof TracerError) || error.code !== "NOT_FOUND")
            throw error
        }
        // Omitted dataset items are retained, including when calculating the resulting revision.
        const merged =
          document.kind === "dataset" && previous?.kind === "dataset"
            ? {
                ...document,
                items: [
                  ...document.items,
                  ...previous.items.filter(
                    (old) =>
                      !document.items.some((item) => item.key === old.key)
                  ),
                ].sort((a, b) => a.key.localeCompare(b.key)),
              }
            : document
        const revision = hash(merged)
        const unchanged = previous && hash(previous) === revision
        const conflict =
          !!previous && !unchanged && expectedRevision !== hash(previous)
        const changes =
          document.kind === "dataset"
            ? document.items.map((item) => ({
                key: item.key,
                action:
                  previous?.kind === "dataset" &&
                  previous.items.some((i) => i.key === item.key)
                    ? previous.items.some(
                        (i) => i.key === item.key && hash(i) === hash(item)
                      )
                      ? "unchanged"
                      : "update"
                    : "create",
              }))
            : [
                {
                  key: document.key,
                  action: unchanged
                    ? "unchanged"
                    : previous
                      ? "update"
                      : "create",
                },
              ]
        if (dryRun) return { revision, conflict, changes }
        if (conflict)
          throw new TracerError(
            "CONFLICT",
            "Resource changed or has no known sync base. Pull before pushing."
          )
        if (unchanged) return { revision, conflict: false, changes }
        if (document.kind === "scorer") {
          const current = (await runTracerEffect(catalog.list())).find(
            (s) => s.slug === document.key
          )
          if (current && !previous)
            throw new TracerError("CONFLICT", "Scorer was created during sync")
          // Recheck the content hash after lookup; catalog.save checks the numeric revision atomically.
          if (
            current &&
            previous &&
            hash(await exportDocument("scorer", document.key)) !==
              hash(previous)
          )
            throw new TracerError("CONFLICT", "Scorer changed during sync")
          await runTracerEffect(
            catalog.save(
              {
                ...document.config,
                ...(current ? { expectedRevision: current.revision } : {}),
              },
              current?.id
            )
          )
        } else {
          await database.transaction(async (tx) => {
            const scoped = scopedTracerTransaction(database, tx)
            await lockDatasetLibrary(scoped)
            await ensureDatasetParents(scoped, document.key)
            const [current] = await tx
              .select()
              .from(datasets)
              .where(and(eq(datasets.projectId, projectId), eq(datasets.name, document.key))).for("update")
            if (current) {
              const rows = await tx
                .select()
                .from(datasetItems)
                .where(and(eq(datasetItems.projectId, projectId), eq(datasetItems.datasetId, current.id)))
              const currentDoc = {
                format: 1,
                kind: "dataset",
                key: current.name,
                description: current.description ?? "",
                items: rows
                  .map((row) => {
                    const metadata = JSON.parse(row.metadataJson)
                    const key = metadata["datool.sync.key"] ?? row.id
                    delete metadata["datool.sync.key"]
                    return {
                      key,
                      input: JSON.parse(row.inputJson),
                      expectedOutput: JSON.parse(
                        row.expectedOutputJson ?? "null"
                      ),
                      metadata,
                    }
                  })
                  .sort((a, b) => a.key.localeCompare(b.key)),
              }
              if (!previous || hash(currentDoc) !== hash(previous))
                throw new TracerError("CONFLICT", "Dataset changed during sync")
            } else if (previous)
              throw new TracerError(
                "CONFLICT",
                "Dataset was removed during sync"
              )
            const id = current?.id ?? `ds_${randomUUID()}`
            const timestamp = new Date().toISOString()
            if (current)
              await tx
                .update(datasets)
                .set({
                  description: document.description,
                  updatedAt: timestamp,
                })
                .where(and(eq(datasets.projectId, projectId), eq(datasets.id, id)))
            else
              await tx
                .insert(datasets)
                .values({ projectId,
                  id,
                  name: document.key,
                  description: document.description,
                  createdAt: timestamp,
                  updatedAt: timestamp,
                })
            const rows = await tx
              .select()
              .from(datasetItems)
              .where(and(eq(datasetItems.projectId, projectId), eq(datasetItems.datasetId, id)))
            for (const item of document.items) {
              const existing = rows.find(
                (row) =>
                  (JSON.parse(row.metadataJson)["datool.sync.key"] ??
                    row.id) === item.key
              )
              validateDatasetItem(current?.fieldSchemasJson ?? "{}", {
                ...item, metadata: { ...item.metadata, "datool.sync.key": item.key },
              })
              const fields = {
                inputJson: JSON.stringify(item.input),
                expectedOutputJson: JSON.stringify(item.expectedOutput),
                metadataJson: JSON.stringify({
                  ...item.metadata,
                  "datool.sync.key": item.key,
                }),
                updatedAt: timestamp,
              }
              if (existing)
                await tx
                  .update(datasetItems)
                  .set(fields)
                  .where(and(eq(datasetItems.projectId, projectId), eq(datasetItems.id, existing.id)))
              else
                await tx
                  .insert(datasetItems)
                  .values({ projectId,
                    ...fields,
                    id: `di_${randomUUID()}`,
                    datasetId: id,
                    createdAt: timestamp,
                  })
            }
          })
        }
        return { revision, conflict: false, changes }
      }),
  }
}
