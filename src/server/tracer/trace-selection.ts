import { and, eq, inArray, sql } from "drizzle-orm"
import type { JsonObject } from "@/src/lib/tracer/contracts"
import { traceSelectionMutationSchema } from "@/src/lib/tracer/trace-selection"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { TracerError, validation } from "./errors"
import { traces } from "./schema"

export function mutateTraceSelection(database: TracerDatabase, value: unknown) {
  return tracerEffect(async () => {
    const parsed = traceSelectionMutationSchema.safeParse(value)
    if (!parsed.success)
      throw validation(
        parsed.error.issues.map((issue) => issue.message).join(" ")
      )
    const input = parsed.data
    const projectId = getTracerProjectId(database)
    const predicate = and(
      eq(traces.projectId, projectId),
      inArray(traces.id, input.traceIds)
    )
    try {
      return await database.transaction(async (transaction) => {
        await transaction.execute(sql`set local statement_timeout = '15s'`)
        await transaction.execute(sql`set local lock_timeout = '2s'`)
        // Lock in a stable order, and validate the entire selection before writing.
        const selected = await transaction
          .select({ id: traces.id, attributes: traces.attributesJson })
          .from(traces)
          .where(predicate)
          .orderBy(traces.id)
          .for("update")
        if (selected.length !== input.traceIds.length) {
          throw new TracerError(
            "NOT_FOUND",
            "Some selected traces are no longer available. Refresh the traces and try again."
          )
        }
        if (input.action === "delete") {
          await transaction.delete(traces).where(predicate)
        } else {
          for (const trace of selected) {
            const attributes: JsonObject = JSON.parse(trace.attributes)
            const previous =
              attributes.tags === undefined
                ? []
                : Array.isArray(attributes.tags)
                  ? attributes.tags
                  : [attributes.tags]
            attributes.tags = [
              ...previous,
              ...input.tags.filter(
                (tag, index) =>
                  !previous.includes(tag) && input.tags.indexOf(tag) === index
              ),
            ]
            await transaction
              .update(traces)
              .set({ attributesJson: JSON.stringify(attributes) })
              .where(
                and(eq(traces.projectId, projectId), eq(traces.id, trace.id))
              )
          }
        }
        return { traceIds: input.traceIds }
      })
    } catch (error) {
      let cause: unknown = error
      for (
        let depth = 0;
        depth < 8 && cause instanceof Error;
        depth++, cause = cause.cause
      ) {
        if ("code" in cause && cause.code === "23503") {
          throw new TracerError(
            "CONFLICT",
            "Some selected traces are used by a review session or evaluation run and cannot be deleted. No traces were deleted."
          )
        }
      }
      throw error
    }
  })
}
