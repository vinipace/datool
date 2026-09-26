import { sql } from "drizzle-orm"
import { z } from "zod"
import {
  humanScoreInputSchema,
  humanScoreUpdateSchema,
  humanScoreCollectionInputSchema,
  humanScoreCollectionUpdateSchema,
  type HumanScore,
  type HumanScoreCollection,
  type HumanScoreCollectionSnapshot,
  type HumanScoreLibrary,
} from "@/src/lib/tracer/human-scores"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"

export function parseHumanInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success)
    throw validation(
      result.error.issues.map((issue) => issue.message).join("; ")
    )
  return result.data
}
type Executor = Pick<TracerDatabase, "execute">
export async function readHumanScore(
  db: Executor,
  projectId: string,
  id: string,
  lock = false
): Promise<HumanScore> {
  const result = await db.execute(
    sql`select config_json as config, id,revision,archived,created_at as "createdAt",updated_at as "updatedAt" from human_scores where project_id=${projectId} and id=${id} ${lock ? sql`for share` : sql``}`
  )
  if (!result.rows[0]) throw notFound("Human Score", id)
  const { config, ...fields } = result.rows[0]
  return { ...humanScoreInputSchema.parse(config), ...fields } as HumanScore
}
export async function readHumanCollection(
  db: Executor,
  projectId: string,
  id: string,
  lock = false
): Promise<HumanScoreCollectionSnapshot> {
  const result = await db.execute(
    sql`select id,name,description,revision,archived,created_at as "createdAt",updated_at as "updatedAt" from human_score_collections where project_id=${projectId} and id=${id} ${lock ? sql`for share` : sql``}`
  )
  if (!result.rows[0]) throw notFound("Human Score collection", id)
  const ids = await db.execute(
    sql`select human_score_id as id from human_score_collection_items where project_id=${projectId} and collection_id=${id} order by ordinal`
  )
  const scores = []
  for (const row of ids.rows)
    scores.push(await readHumanScore(db, projectId, String(row.id), lock))
  return {
    ...result.rows[0],
    scoreIds: scores.map((score) => score.id),
    scores,
  } as HumanScoreCollectionSnapshot
}
function conflict(revision: number, expected: number) {
  if (revision !== expected)
    throw new TracerError(
      "CONFLICT",
      "The Human Score library changed. Reload before saving."
    )
}
async function uniqueName<T>(action: () => Promise<T>) {
  try {
    return await action()
  } catch (error) {
    const cause = error as { cause?: { code?: string }; code?: string }
    if (cause.code === "23505" || cause.cause?.code === "23505")
      throw validation(
        "A Human Score or collection with this name already exists."
      )
    throw error
  }
}
export function createHumanScoreService(database: TracerDatabase) {
  const projectId = getTracerProjectId(database)
  return {
    library: () =>
      tracerEffect(async (): Promise<HumanScoreLibrary> =>
        database.transaction(
          async (tx) => {
            const definitions = await tx.execute(
              sql`select id from human_scores where project_id=${projectId} and not archived order by lower(name) limit 501`
            )
            const collections = await tx.execute(
              sql`select id from human_score_collections where project_id=${projectId} and not archived order by lower(name) limit 501`
            )
            if (definitions.rows.length > 500 || collections.rows.length > 500)
              throw validation("The Human Score library exceeds 500 entries.")
            const scores = []
            const groups: HumanScoreCollection[] = []
            for (const row of definitions.rows)
              scores.push(await readHumanScore(tx, projectId, String(row.id)))
            for (const row of collections.rows) {
              const { scores: members, ...collection } =
                await readHumanCollection(tx, projectId, String(row.id))
              void members
              groups.push(collection)
            }
            return { scores, collections: groups }
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        )
      ),
    get: (id: string) =>
      tracerEffect(() => readHumanScore(database, projectId, id)),
    collection: (id: string) =>
      tracerEffect(() =>
        database.transaction((tx) => readHumanCollection(tx, projectId, id), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        })
      ),
    create: (input: unknown) =>
      tracerEffect(() =>
        uniqueName(async () => {
          const config = parseHumanInput(humanScoreInputSchema, input)
          const id = `human_${crypto.randomUUID()}`,
            now = new Date().toISOString()
          await database.execute(
            sql`insert into human_scores(id,project_id,name,config_json,created_at,updated_at) values(${id},${projectId},${config.name},${JSON.stringify(config)}::jsonb,${now},${now})`
          )
          return readHumanScore(database, projectId, id)
        })
      ),
    update: (id: string, input: unknown) =>
      tracerEffect(() =>
        uniqueName(() =>
          database.transaction(async (tx) => {
            const value = parseHumanInput(humanScoreUpdateSchema, input)
            const result = await tx.execute(
              sql`select revision from human_scores where project_id=${projectId} and id=${id} for update`
            )
            if (!result.rows[0]) throw notFound("Human Score", id)
            conflict(Number(result.rows[0].revision), value.expectedRevision)
            await tx.execute(
              sql`update human_scores set name=${value.score.name},config_json=${JSON.stringify(value.score)}::jsonb,revision=revision+1,updated_at=${new Date().toISOString()} where project_id=${projectId} and id=${id}`
            )
            return readHumanScore(tx, projectId, id)
          })
        )
      ),
    createCollection: (input: unknown) =>
      tracerEffect(() =>
        uniqueName(() =>
          database.transaction(async (tx) => {
            const value = parseHumanInput(
              humanScoreCollectionInputSchema,
              input
            )
            const id = `human_collection_${crypto.randomUUID()}`,
              now = new Date().toISOString()
            for (const scoreId of [...value.scoreIds].sort())
              if ((await readHumanScore(tx, projectId, scoreId, true)).archived)
                throw validation("Choose active Human Scores.")
            await tx.execute(
              sql`insert into human_score_collections(id,project_id,name,description,created_at,updated_at) values(${id},${projectId},${value.name},${value.description},${now},${now})`
            )
            for (const [ordinal, scoreId] of value.scoreIds.entries())
              await tx.execute(
                sql`insert into human_score_collection_items(project_id,collection_id,human_score_id,ordinal) values(${projectId},${id},${scoreId},${ordinal})`
              )
            return readHumanCollection(tx, projectId, id)
          })
        )
      ),
    updateCollection: (id: string, input: unknown) =>
      tracerEffect(() =>
        uniqueName(() =>
          database.transaction(async (tx) => {
            const value = parseHumanInput(
              humanScoreCollectionUpdateSchema,
              input
            )
            const result = await tx.execute(
              sql`select revision from human_score_collections where project_id=${projectId} and id=${id} for update`
            )
            if (!result.rows[0]) throw notFound("Human Score collection", id)
            conflict(Number(result.rows[0].revision), value.expectedRevision)
            for (const scoreId of [...value.collection.scoreIds].sort())
              if ((await readHumanScore(tx, projectId, scoreId, true)).archived)
                throw validation("Choose active Human Scores.")
            await tx.execute(
              sql`update human_score_collections set name=${value.collection.name},description=${value.collection.description},revision=revision+1,updated_at=${new Date().toISOString()} where project_id=${projectId} and id=${id}`
            )
            await tx.execute(
              sql`delete from human_score_collection_items where project_id=${projectId} and collection_id=${id}`
            )
            for (const [
              ordinal,
              scoreId,
            ] of value.collection.scoreIds.entries())
              await tx.execute(
                sql`insert into human_score_collection_items(project_id,collection_id,human_score_id,ordinal) values(${projectId},${id},${scoreId},${ordinal})`
              )
            return readHumanCollection(tx, projectId, id)
          })
        )
      ),
  }
}
