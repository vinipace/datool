import { sql, type SQL } from "drizzle-orm"
import { isDeepStrictEqual } from "node:util"
import { z } from "zod"
import {
  recordReviewSchema,
  reviewSelectionSchema,
  reviewSessionInputSchema,
  reviewSessionUpdateSchema,
  type ReviewItem,
  type ReviewItemDetail,
  type ReviewMember,
  type ReviewOptions,
  type ReviewScore,
  type ReviewSession,
  type ReviewSessionDetail,
  type ReviewSessionTable,
} from "@/src/lib/tracer/reviews"
import {
  isHumanScoreValue,
  humanScoreValueLabel,
  type HumanScore,
  type HumanScoreCollectionSnapshot,
} from "@/src/lib/tracer/human-scores"
import { readHumanCollection, readHumanScore } from "./human-scores"
import type { ReviewProvenance } from "@/src/lib/tracer/review-provenance"
import { workspaceIdentity } from "@/src/server/auth/context"
import { getTracerProjectId, type TracerDatabase } from "./db"
import { collectionSqlFilter, collectionSqlPage } from "./collection-sql"
import { tracerEffect } from "./effect"
import { notFound, TracerError, validation } from "./errors"
import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { customFieldSource, customFieldValue, outputHash, type ReviewAnnotation } from "@/src/lib/tracer/review-annotations"
import type { ComputedColumn } from "@/src/lib/tracer/computed-columns"

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success)
    throw validation(
      result.error.issues.map((issue) => issue.message).join("; ")
    )
  return result.data
}

export function createReviewService(
  database: TracerDatabase,
  readTraces: (
    db: Pick<TracerDatabase, "select" | "execute">,
    ids: string[]
  ) => Promise<TraceSummary[]>
) {
  const projectId = getTracerProjectId(database)
  const aiScores = sql`exists(select 1 from review_scores s where s.project_id=i.project_id and s.item_id=i.id and s.source<>'human')`
  const humanVerified = sql`(i.reviewed_at is not null and not ${aiScores} and exists(select 1 from review_scores s where s.project_id=i.project_id and s.item_id=i.id))`
  const aiLabelled = sql`(${aiScores} or i.notes_provenance_json->>'label'='AI-labelled'
    or i.last_submission_json->>'label'='AI-labelled'
    or exists(select 1 from jsonb_array_elements(i.annotations_json) a where a->'provenance'->>'label'='AI-labelled' or a->'updatedBy'->>'label'='AI-labelled'))`
  const sessionRelation = sql`select r.default_object_view_id as "defaultObjectViewId", r.collection_id as "collectionId", r.collection_snapshot_json as collection, r.id, r.number, r.name, r.prompt, r.assignee_user_id as "assigneeUserId",
    u.name as "assigneeName", assigned.reviewers, assigned.names as "reviewerNames", r.created_by as "createdBy", r.created_at as "createdAt",
    r.updated_at as "updatedAt", r.revision, counts.total::int as "traceCount", counts.reviewed::int as "reviewedCount",
    counts.skipped::int as "skippedCount", counts.human::int as "humanReviewedCount",
    counts.ai::int as "aiReviewedCount", counts.labelled::int as "aiLabelledCount",
    case when counts.labelled>0 then 'AI-labelled' when counts.human>0 then 'Human-reviewed' else 'Unreviewed' end as label,
    case when counts.reviewed+counts.skipped=counts.total then 'completed' when counts.reviewed+counts.skipped>0 then 'in_progress' else 'pending' end as status
    from review_sessions r left join "user" u on u.id=r.assignee_user_id
    cross join lateral (select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'name',u.name,'image',u.image) order by a.ordinal),'[]'::jsonb) as reviewers,
      string_agg(u.name, ', ' order by a.ordinal) as names
      from review_session_reviewers a join "user" u on u.id=a.user_id where a.project_id=r.project_id and a.session_id=r.id) assigned
    cross join lateral (select count(*) as total, count(reviewed_at) filter(where skipped_at is null) as reviewed, count(skipped_at) as skipped,
      count(*) filter(where i.skipped_at is null and ${humanVerified}) as human,
      count(*) filter(where i.skipped_at is null and i.reviewed_at is not null and ${aiScores}) as ai,
      count(*) filter(where ${aiLabelled}) as labelled from review_items i
      where i.project_id=r.project_id and i.session_id=r.id) counts where r.project_id=${projectId}`
  const itemRelation = sql`select i.id, i.session_id as "sessionId", i.trace_id as "traceId", t.name as "traceName",
    i.ordinal, i.notes, i.revision, i.reviewed_at as "reviewedAt", i.skipped_at as "skippedAt", i.reviewed_by as "reviewedBy",
    i.notes_provenance_json as "notesProvenance", i.last_submission_json as "lastSubmission",
    (${humanVerified} and not coalesce(${aiLabelled},false)) as "humanVerified",
    case when i.reviewed_at is null then null when ${aiScores} then 'ai' else 'human' end as "completionKind",
    case when ${aiLabelled} then 'AI-labelled' when ${humanVerified} then 'Human-reviewed'
      when i.notes<>'' or jsonb_array_length(i.annotations_json)>0 then coalesce(i.notes_provenance_json->>'label',i.last_submission_json->>'label','Unknown provenance') else 'Unreviewed' end as label
    from review_items i join traces t on t.project_id=i.project_id and t.id=i.trace_id where i.project_id=${projectId}`
  const scoreRelation = sql`select s.id, s.item_id as "itemId", s.trace_id as "traceId", s.scorer_id as "scorerId",
    s.scorer_revision as "scorerRevision", s.name, s.human_value as value, s.human_score_id as "humanScoreId", s.definition_json as definition, s.comment, s.reviewer_id as "reviewerId",
    coalesce(s.edited_by_json->'principal'->>'name',s.provenance_json->'principal'->>'name',u.name) as "reviewerName", u.image as "reviewerImage", s.source, s.provenance_json as provenance, s.edited_by_json as "editedBy", s.updated_at as "updatedAt"
    from review_scores s left join "user" u on u.id=s.reviewer_id where s.project_id=${projectId}`
  type Executor = Pick<TracerDatabase, "execute">
  async function validateDefaultView(db: Executor, id: string | null) {
    if (!id) return
    const [view] = await rows<{ id: string }>(db,
      sql`select id from react_views where project_id=${projectId} and id=${id}
        and object_types @> '["trace"]'::jsonb for key share`)
    if (!view) throw validation("Choose a trace Object View from this project.")
  }
  async function rows<T>(db: Executor, query: SQL): Promise<T[]> {
    return (await db.execute(query)).rows as T[]
  }
  async function resolveSessionId(
    db: Executor,
    reference: string
  ): Promise<string> {
    if (!/^\d+$/.test(reference)) return reference
    const number = Number(reference)
    if (!Number.isSafeInteger(number) || number < 1 || number > 2147483647)
      throw validation("Review number must be a positive integer.")
    const [session] = await rows<{ id: string }>(
      db,
      sql`select id from review_sessions where project_id=${projectId} and number=${number}`
    )
    if (!session) throw notFound("Review session", reference)
    return session.id
  }
  async function member(db: Executor, userId: string) {
    const [row] = await rows<ReviewMember>(
      db,
      sql`select u.id,u.name,u.email,u.image from "user" u
      join member m on m."userId"=u.id join project p on p.organization_id=m."organizationId"
      where p.id=${projectId} and u.id=${userId}
      and exists(select 1 from unnest(string_to_array(m.role, ',')) role where btrim(role) in ('owner','admin','member')) limit 1`
    )
    if (!row)
      throw validation(
        "The reviewer must be a member with access to this project."
      )
    return row
  }
  async function setReviewers(db: Executor, sessionId: string, ids: string[]) {
    for (const id of ids) await member(db, id)
    await db.execute(
      sql`delete from review_session_reviewers where project_id=${projectId} and session_id=${sessionId}`
    )
    if (ids.length)
      await db.execute(
        sql`insert into review_session_reviewers(project_id,session_id,user_id,ordinal) values ${sql.join(
          ids.map(
            (id, ordinal) => sql`(${projectId},${sessionId},${id},${ordinal})`
          ),
          sql`,`
        )}`
      )
  }
  async function getSession(
    db: Executor,
    id: string
  ): Promise<ReviewSessionDetail> {
    id = await resolveSessionId(db, id)
    const [session] = await rows<ReviewSession>(
      db,
      sql`${sessionRelation} and r.id=${id}`
    )
    if (!session) throw notFound("Review session", id)
    const items = await rows<ReviewItem>(
      db,
      sql`${itemRelation} and i.session_id=${id} order by i.ordinal limit 500`
    )
    return { ...session, items }
  }
  async function getItem(
    db: Executor,
    sessionId: string,
    itemId: string
  ): Promise<ReviewItemDetail> {
    const [item] = await rows<ReviewItem>(
      db,
      sql`${itemRelation} and i.session_id=${sessionId} and i.id=${itemId}`
    )
    if (!item) throw notFound("Review item", itemId)
    const [feedback] = await rows<{ annotations: ReviewAnnotation[]; criteria: HumanScore[] | null }>(db,
      sql`select annotations_json as annotations, criteria_snapshot_json as criteria from review_items where project_id=${projectId} and id=${itemId}`)
    const scores = await rows<ReviewScore>(
      db,
      sql`${scoreRelation} and s.item_id=${itemId} order by s.name limit 30`
    )
    const neighbors = await rows<{ id: string; ordinal: number }>(
      db,
      sql`(select id, ordinal from review_items
      where project_id=${projectId} and session_id=${sessionId} and skipped_at is null and ordinal < ${item.ordinal} order by ordinal desc limit 1)
      union all (select id, ordinal from review_items
      where project_id=${projectId} and session_id=${sessionId} and skipped_at is null and ordinal > ${item.ordinal} order by ordinal limit 1)`
    )
    const session = await rows<{
      collection: HumanScoreCollectionSnapshot | null
    }>(
      db,
      sql`select collection_snapshot_json as collection from review_sessions where project_id=${projectId} and id=${sessionId}`
    )
    return {
      ...item,
      annotations: feedback.annotations,
      // Existing feedback retains the rubric it was recorded against, even
      // when another collection now includes a newer version of that score.
      definitions: (feedback.criteria ?? session[0]?.collection?.scores ?? []).map(
        (definition) =>
          scores.find((score) => score.humanScoreId === definition.id)
            ?.definition ?? definition
      ),
      scores,
      previousItemId:
        neighbors.find((row) => row.ordinal < item.ordinal)?.id ?? null,
      nextItemId:
        neighbors.find((row) => row.ordinal > item.ordinal)?.id ?? null,
    }
  }
  return {
    table: (id: string) =>
      tracerEffect(() =>
        database.transaction(
          async (tx): Promise<ReviewSessionTable> => {
            const session = await getSession(tx, id)
            const scores = await rows<
              Pick<
                ReviewScore,
                "itemId" | "humanScoreId" | "definition" | "value" | "provenance"
              >
            >(
              tx,
              sql`select s.item_id as "itemId", s.human_score_id as "humanScoreId", s.definition_json as definition, s.human_value as value, s.provenance_json as provenance
                from review_scores s join review_items i on i.project_id=s.project_id and i.id=s.item_id
                where i.project_id=${projectId} and i.session_id=${session.id}
                order by s.name, i.ordinal, s.id`
            )
            const columns = new Map(
              (session.collection?.scores ?? []).map((score) => [
                score.id,
                { id: score.id, name: score.name, type: score.type },
              ])
            )
            for (const score of scores) {
              if (!columns.has(score.humanScoreId))
                columns.set(score.humanScoreId, {
                  id: score.humanScoreId,
                  name: score.definition.name,
                  type: score.definition.type,
                })
            }
            return {
              ...session,
              scoreColumns: [...columns.values()],
              scores: scores.map((score) => ({
                itemId: score.itemId,
                humanScoreId: score.humanScoreId,
                value: score.value,
                provenance: score.provenance,
                valueLabel:
                  score.value === null
                    ? null
                    : humanScoreValueLabel(score.definition, score.value),
              })),
              traces: await readTraces(
                tx,
                session.items.map((item) => item.traceId)
              ),
            }
          },
          { isolationLevel: "repeatable read", accessMode: "read only" }
        )
      ),
    exportItems: (id: string, options: { cursor?: string | null; limit?: number } = {}) =>
      tracerEffect(() => database.transaction(async (tx) => {
        const session = await getSession(tx, id)
        const start = options.cursor ? session.items.findIndex(item => item.id === options.cursor) + 1 : 0
        if (options.cursor && !start) throw validation("Unknown review export cursor.")
        const selected = session.items.slice(start, start + (options.limit ?? 20))
        const items = await Promise.all(selected.map(item => getItem(tx, session.id, item.id)))
        return { items, nextCursor: start + selected.length < session.items.length ? selected.at(-1)!.id : null }
      }, { isolationLevel: "repeatable read", accessMode: "read only" })),
    mutateSelection: (id: string, input: unknown) =>
      tracerEffect(async () => {
        const value = parse(reviewSelectionSchema, input)
        return database.transaction(async (tx) => {
          id = await resolveSessionId(tx, id)
          await tx.execute(sql`set local statement_timeout = '15s'`)
          await tx.execute(sql`set local lock_timeout = '2s'`)
          const [session] = await rows<{ revision: number }>(
            tx,
            sql`select revision from review_sessions where project_id=${projectId} and id=${id} for update`
          )
          if (!session) throw notFound("Review session", id)
          if (session.revision !== value.expectedRevision)
            throw new TracerError(
              "CONFLICT",
              "Session changed. Refresh before updating the selection."
            )
          const ids = sql.join(
            value.items.map((item) => sql`${item.id}`),
            sql`, `
          )
          const selected = await rows<{ id: string; revision: number }>(
            tx,
            sql`select id, revision from review_items where project_id=${projectId} and session_id=${id} and id in (${ids}) order by id for update`
          )
          if (selected.length !== value.items.length)
            throw validation(
              "Every selected item must belong to this review session."
            )
          const revisions = new Map(
            value.items.map((item) => [item.id, item.expectedRevision])
          )
          if (selected.some((item) => item.revision !== revisions.get(item.id)))
            throw new TracerError(
              "CONFLICT",
              "A selected review changed. Refresh before updating the selection."
            )
          if (value.action === "remove") {
            await tx.execute(
              sql`delete from review_items where project_id=${projectId} and session_id=${id} and id in (${ids})`
            )
          } else {
            await tx.execute(sql`update review_items set skipped_at=${value.action === "skip" ? new Date().toISOString() : null}, revision=revision+1
            where project_id=${projectId} and session_id=${id} and id in (${ids})`)
          }
          await tx.execute(
            sql`update review_sessions set revision=revision+1,updated_at=${new Date().toISOString()} where project_id=${projectId} and id=${id}`
          )
          return getSession(tx, id)
        })
      }),
    list: (
      options: {
        cursor?: string | null
        limit?: number
        includeTotal?: boolean
        filter?: string
      } = {}
    ) =>
      tracerEffect(async () => {
        const filter = collectionSqlFilter("reviews", options.filter, {
          id: { value: sql`id`, type: "string" },
          name: { value: sql`name`, type: "string" },
          status: { value: sql`status`, type: "string" },
          assigneeName: { value: sql`"reviewerNames"`, type: "string" },
          traceCount: { value: sql`"traceCount"`, type: "number" },
          reviewedCount: { value: sql`"reviewedCount"`, type: "number" },
          createdAt: { value: sql`"createdAt"`, type: "date" },
        })
        return collectionSqlPage<ReviewSession>(
          database,
          sql`select * from (${sessionRelation}) reviews where ${filter}`,
          options,
          "createdAt"
        )
      }),
    get: (id: string) =>
      tracerEffect(() =>
        database.transaction((tx) => getSession(tx, id), {
          isolationLevel: "repeatable read",
          accessMode: "read only",
        })
      ),
    item: (sessionId: string, itemId: string) =>
      tracerEffect(() =>
        database.transaction(
          async (tx) =>
            getItem(tx, await resolveSessionId(tx, sessionId), itemId),
          {
            isolationLevel: "repeatable read",
            accessMode: "read only",
          }
        )
      ),
    options: () =>
      tracerEffect(async (): Promise<ReviewOptions> => {
        const members = await rows<ReviewMember>(
          database,
          sql`select distinct u.id,u.name,u.email,u.image from "user" u
        join member m on m."userId"=u.id join project p on p.organization_id=m."organizationId" where p.id=${projectId}
        and exists(select 1 from unnest(string_to_array(m.role, ',')) role where btrim(role) in ('owner','admin','member')) order by u.name,u.id limit 501`
        )
        if (members.length > 500)
          throw new TracerError(
            "READ_RESULT_TOO_LARGE",
            "Review options exceed 500 entries."
          )
        return {
          members,
          currentUserId: workspaceIdentity()?.userId ?? null,
        }
      }),
    create: (input: unknown) =>
      tracerEffect(async () => {
        const value = parse(reviewSessionInputSchema, input)
        return database.transaction(async (tx) => {
          const reviewerUserIds =
            value.reviewerUserIds ??
            (value.assigneeUserId ? [value.assigneeUserId] : [])
          const createdBy = workspaceIdentity()?.userId ?? null
          if (createdBy) await member(tx, createdBy)
          const id = `review_${value.idempotencyKey ?? crypto.randomUUID()}`
          if (value.idempotencyKey) {
            await tx.execute(
              sql`select pg_advisory_xact_lock(hashtextextended(${`review-create:${projectId}:${id}`}, 0))`
            )
            const [existing] = await rows<{ createdBy: string | null }>(
              tx,
              sql`select created_by as "createdBy" from review_sessions where project_id=${projectId} and id=${id}`
            )
            if (existing) {
              if (existing.createdBy !== createdBy)
                throw new TracerError(
                  "CONFLICT",
                  "This creation key belongs to another reviewer."
                )
              return getSession(tx, id)
            }
          }
          const found = await rows<{ id: string }>(
            tx,
            sql`select id from traces where project_id=${projectId} and id in (${sql.join(
              value.traceIds.map((id) => sql`${id}`),
              sql`,`
            )}) for key share`
          )
          if (found.length !== value.traceIds.length)
            throw validation("Every trace must exist in this project.")
          const collection = value.collectionId
            ? await readHumanCollection(tx, projectId, value.collectionId, true)
            : null
          if (
            collection?.archived ||
            collection?.scores.some((score) => score.archived)
          )
            throw validation("Choose an active collection and Human Scores.")
          const now = new Date().toISOString()
          await validateDefaultView(tx, value.defaultObjectViewId)
          await tx.execute(sql`insert into review_sessions (id,project_id,name,prompt,assignee_user_id,created_by,created_at,updated_at,collection_id,collection_snapshot_json,default_object_view_id)
          values (${id},${projectId},${value.name},${value.prompt},${reviewerUserIds[0] ?? null},${createdBy},${now},${now},${value.collectionId},${collection ? JSON.stringify(collection) : null}::jsonb,${value.defaultObjectViewId})`)
          await setReviewers(tx, id, reviewerUserIds)
          await tx.execute(
            sql`insert into review_items (id,project_id,session_id,trace_id,ordinal) values ${sql.join(
              value.traceIds.map(
                (traceId, ordinal) =>
                  sql`(${`review_item_${crypto.randomUUID()}`},${projectId},${id},${traceId},${ordinal})`
              ),
              sql`,`
            )}`
          )
          return getSession(tx, id)
        })
      }),
    update: (id: string, input: unknown) =>
      tracerEffect(async () => {
        const value = parse(reviewSessionUpdateSchema, input)
        return database.transaction(async (tx) => {
          id = await resolveSessionId(tx, id)
          const [session] = await rows<{ revision: number }>(
            tx,
            sql`select revision from review_sessions where project_id=${projectId} and id=${id} for update`
          )
          if (!session) throw notFound("Review session", id)
          if (session.revision !== value.expectedRevision)
            throw new TracerError(
              "CONFLICT",
              "Session changed. Reload before saving."
            )
          if (
            !value.name &&
            value.prompt === undefined &&
            value.assigneeUserId === undefined &&
            value.reviewerUserIds === undefined &&
            value.collectionId === undefined &&
            value.defaultObjectViewId === undefined
          )
            return getSession(tx, id)
          const reviewerUserIds =
            value.reviewerUserIds ??
            (value.assigneeUserId !== undefined
              ? value.assigneeUserId
                ? [value.assigneeUserId]
                : []
              : undefined)
          if (reviewerUserIds) await setReviewers(tx, id, reviewerUserIds)
          const changes = [
            sql`revision=revision+1`,
            sql`updated_at=${new Date().toISOString()}`,
          ]
          if (value.defaultObjectViewId !== undefined) {
            await validateDefaultView(tx, value.defaultObjectViewId)
            changes.push(sql`default_object_view_id=${value.defaultObjectViewId}`)
          }
          if (value.collectionId !== undefined) {
            const collection = value.collectionId
              ? await readHumanCollection(
                  tx,
                  projectId,
                  value.collectionId,
                  true
                )
              : null
            if (
              collection?.archived ||
              collection?.scores.some((score) => score.archived)
            )
              throw validation("Choose an active collection and Human Scores.")
            changes.push(
              sql`collection_id=${value.collectionId}`,
              sql`collection_snapshot_json=${collection ? JSON.stringify(collection) : null}::jsonb`
            )
            // Keep ratings and notes, but invalidate stale player drafts and
            // recalculate completion against the newly required criteria.
            const required = JSON.stringify(collection?.scoreIds ?? [])
            const tooMany = await rows<{ itemId: string }>(
              tx,
              sql`
              with criteria as (
                select i.id as item_id, s.human_score_id as score_id from review_items i
                join review_scores s on s.project_id=i.project_id and s.item_id=i.id
                where i.project_id=${projectId} and i.session_id=${id}
                union
                select i.id, required.score_id from review_items i
                cross join jsonb_array_elements_text(${required}::jsonb) required(score_id)
                where i.project_id=${projectId} and i.session_id=${id} and i.criteria_snapshot_json is null
              ) select item_id as "itemId" from criteria group by item_id having count(*)>30 limit 1`
            )
            if (tooMany.length)
              throw validation(
                "This collection and existing ratings exceed the limit of 30 Human Scores per trace. Choose a smaller collection."
              )
            const now = new Date().toISOString()
            await tx.execute(sql`with completion as (
              select i.id,
                exists(select 1 from review_scores s where s.project_id=i.project_id and s.item_id=i.id)
                and not exists(select 1 from review_scores s where s.project_id=i.project_id and s.item_id=i.id and (s.human_value is null or s.human_value='null'::jsonb))
                and not exists(select 1 from jsonb_array_elements_text(case when i.criteria_snapshot_json is null then ${required}::jsonb
                  else (select coalesce(jsonb_agg(criterion->>'id'),'[]'::jsonb) from jsonb_array_elements(i.criteria_snapshot_json) criterion) end) required(score_id)
                  where not exists(select 1 from review_scores s where s.project_id=i.project_id and s.item_id=i.id and s.human_score_id=required.score_id)) as complete,
                (select s.reviewer_id from review_scores s where s.project_id=i.project_id and s.item_id=i.id order by s.updated_at desc,s.id desc limit 1) as last_reviewer
              from review_items i where i.project_id=${projectId} and i.session_id=${id}
            ) update review_items i set revision=i.revision+1,
              reviewed_at=case when c.complete then coalesce(i.reviewed_at,${now}) else null end,
              reviewed_by=case when c.complete then coalesce(i.reviewed_by,c.last_reviewer) else null end
              from completion c where i.project_id=${projectId} and i.id=c.id`)
          }
          if (value.name) changes.push(sql`name=${value.name}`)
          if (value.prompt !== undefined)
            changes.push(sql`prompt=${value.prompt}`)
          if (reviewerUserIds)
            changes.push(sql`assignee_user_id=${reviewerUserIds[0] ?? null}`)
          await tx.execute(
            sql`update review_sessions set ${sql.join(changes, sql`,`)} where project_id=${projectId} and id=${id}`
          )
          return getSession(tx, id)
        })
      }),
    record: (sessionId: string, itemId: string, input: unknown) =>
      tracerEffect(async () => {
        const value = parse(recordReviewSchema, input)
        const identity = workspaceIdentity()
        if (!identity || identity.projectId !== projectId ||
          (identity.kind === "api-key" ? !identity.apiKeyId : !identity.userId))
          throw new TracerError(
            "UNAUTHORIZED",
            "An authenticated user or organization API key is required to record an attributed review.",
            { status: 403 }
          )
        if (!identity.scopes.includes("reviews:write"))
          throw new TracerError("UNAUTHORIZED", "Missing required permission: reviews:write.", { status: 403 })
        return database.transaction(async (tx) => {
          const author = identity.kind === "api-key"
            ? { id: identity.apiKeyId!, name: identity.apiKeyName ?? "API key", image: null }
            : await member(tx, identity.userId!)
          const isHuman = identity.kind === "session" && !value.agent
          const provenance: ReviewProvenance = {
            label: isHuman ? "Human-reviewed" : "AI-labelled",
            authType: identity.kind,
            principal: { type: identity.kind === "api-key" ? "api-key" : "user", id: author.id, name: author.name },
            ...(identity.clientId ? { clientId: identity.clientId } : {}),
            ...(value.agent ? { agent: value.agent } : {}),
          }
          const encodedProvenance = JSON.stringify(provenance)
          sessionId = await resolveSessionId(tx, sessionId)
          const [session] = await rows<{ id: string }>(
            tx,
            sql`select id from review_sessions where project_id=${projectId} and id=${sessionId} for update`
          )
          if (!session) throw notFound("Review session", sessionId)
          const item = await getItem(tx, sessionId, itemId)
          if (item.skippedAt)
            throw new TracerError(
              "CONFLICT",
              "This trace is skipped. Restore it before reviewing."
            )
          if (item.revision !== value.expectedRevision)
            throw new TracerError(
              "CONFLICT",
              "This trace was reviewed by someone else. Reload before saving."
            )
          const entries = []
          const keys = new Set<string>()
          for (const score of value.scores ?? []) {
            const definition =
              item.definitions.find(
                (definition) => definition.id === score.humanScoreId
              ) ??
              item.scores.find(
                (saved) => saved.humanScoreId === score.humanScoreId
              )?.definition ??
              (await readHumanScore(tx, projectId, score.humanScoreId, true))
            if (definition.revision !== score.humanScoreRevision)
              throw new TracerError(
                "CONFLICT",
                "Human Score changed. Reload before rating it."
              )
            if (
              score.value !== null &&
              !isHumanScoreValue(definition, score.value)
            )
              throw validation(`Invalid value for ${definition.name}.`)
            const key = `human:${definition.id}`
            if (keys.has(key))
              throw validation(
                "Each Human Score can appear only once in a review."
              )
            keys.add(key)
            entries.push({
              ...score,
              key,
              name: definition.name,
              definition,
              normalized:
                score.value !== null && definition.type === "numeric"
                  ? (Number(score.value) - definition.min) /
                    (definition.max - definition.min)
                  : null,
            })
          }
          const now = new Date().toISOString()
          // The item revision protects this complete replacement of its review criteria.
          const retained = keys.size
            ? sql`and criterion_key not in (${sql.join(
                [...keys].map((key) => sql`${key}`),
                sql`,`
              )})`
            : sql``
          if (value.scores !== undefined)
            await tx.execute(
              sql`delete from review_scores where project_id=${projectId} and item_id=${itemId} ${retained}`
            )
          for (const entry of entries) {
            await tx.execute(sql`insert into review_scores (id,project_id,item_id,trace_id,criterion_key,human_score_id,definition_json,human_value,name,value,comment,reviewer_id,source,provenance_json,edited_by_json,updated_at)
            values (${`review_score_${crypto.randomUUID()}`},${projectId},${itemId},${item.traceId},${entry.key},${entry.humanScoreId},${JSON.stringify(entry.definition)}::jsonb,${JSON.stringify(entry.value)}::jsonb,${entry.name},${entry.normalized},${entry.comment},${identity.kind === "api-key" ? null : identity.userId},${isHuman ? "human" : identity.kind === "oauth" ? "mcp" : "api"},${encodedProvenance}::jsonb,${encodedProvenance}::jsonb,${now})
            on conflict (project_id,item_id,criterion_key) do update set definition_json=excluded.definition_json,human_value=excluded.human_value,name=excluded.name,value=excluded.value,
              comment=excluded.comment,reviewer_id=excluded.reviewer_id,
              source=case when review_scores.source<>'human' and review_scores.human_value is not distinct from excluded.human_value then review_scores.source else excluded.source end,
              provenance_json=case when review_scores.source<>'human' and review_scores.human_value is not distinct from excluded.human_value then review_scores.provenance_json else excluded.provenance_json end,edited_by_json=excluded.edited_by_json,updated_at=excluded.updated_at
            where review_scores.human_value is distinct from excluded.human_value
              or review_scores.comment is distinct from excluded.comment`)
          }
          const complete =
            entries.length > 0 &&
            entries.every((entry) => entry.value !== null) &&
            (value.replaceCriteria ? entries.map(entry => entry.definition) : item.definitions).every((definition) =>
              keys.has(`human:${definition.id}`)
            )
          const changes = [sql`revision=revision+1`, sql`last_submission_json=${encodedProvenance}::jsonb`]
          if (value.replaceCriteria)
            changes.push(sql`criteria_snapshot_json=${JSON.stringify(entries.map(entry => entry.definition))}::jsonb`)
          if (value.annotations !== undefined) {
            const annotations: ReviewAnnotation[] = []
            for (const entry of value.annotations) {
              const previous = item.annotations.find((annotation) => annotation.id === entry.id)
              if (previous) {
                if (!isDeepStrictEqual({ ...previous.reference, spanName: entry.reference.spanName }, entry.reference))
                  throw validation("An annotation's reference cannot be changed.")
                annotations.push({ ...previous, comment: entry.comment,
                  updatedBy: entry.comment === previous.comment ? previous.updatedBy : provenance,
                  updatedAt: entry.comment === previous.comment ? previous.updatedAt : now })
                continue
              }
              const ref = entry.reference
              if (ref.traceId !== item.traceId) throw validation("Annotation must reference this review trace.")
              const [source] = await rows<{ input: string | null; output: string | null; name: string | null }>(tx, ref.spanId
                ? sql`select input_json as input, output_json as output, name from spans where project_id=${projectId} and trace_id=${item.traceId} and id=${ref.spanId}`
                : sql`select input_json as input, output_json as output, name from traces where project_id=${projectId} and id=${item.traceId}`)
              if (!source) throw validation("Annotation span does not belong to this trace.")
              if (ref.field === "custom") {
                const captured = ref.customField!
                const [field] = await rows<{ definition: string }>(tx,
                  sql`select definition_json as definition from custom_fields where project_id=${projectId} and id=${captured.id}`)
                if (!field) throw validation("Custom field does not belong to this project.")
                const definition: ComputedColumn = JSON.parse(field.definition)
                const [trace] = await readTraces(tx, [item.traceId])
                // Custom code runs only in the browser sandbox. Preserve its displayed
                // value as a snapshot; validate the definition and source evidence here.
                if (!isDeepStrictEqual(customFieldValue(definition, captured.value), customFieldValue(captured, captured.value)) ||
                    await outputHash(customFieldValue(captured, captured.value)) !== ref.outputHash ||
                    await outputHash(customFieldSource(trace)) !== captured.sourceHash)
                  throw validation("Custom field changed. Select the passage again before commenting.")
              } else {
                const value = source[ref.field]
                if (value === null || await outputHash(JSON.parse(value)) !== ref.outputHash)
                  throw validation(`${ref.field === "input" ? "Input" : "Output"} changed. Select the passage again before commenting.`)
              }
              annotations.push({ ...entry, reference: { ...ref, spanName: source.name ?? "Trace" },
                author: { id: author.id, name: author.name, image: author.image }, provenance, updatedBy: provenance, createdAt: now, updatedAt: now })
            }
            changes.push(sql`annotations_json=${JSON.stringify(annotations)}::jsonb`)
          }
          if (value.notes !== undefined && value.notes !== item.notes)
            changes.push(sql`notes=${value.notes}`, sql`notes_provenance_json=${encodedProvenance}::jsonb`)
          if (value.scores !== undefined)
            changes.push(
              sql`reviewed_at=${complete ? now : null},reviewed_by=${complete && identity.kind !== "api-key" ? identity.userId : null}`
            )
          await tx.execute(
            sql`update review_items set ${sql.join(changes, sql`, `)} where project_id=${projectId} and id=${itemId}`
          )
          await tx.execute(
            sql`update review_sessions set updated_at=${now} where project_id=${projectId} and id=${sessionId}`
          )
          return getItem(tx, sessionId, itemId)
        })
      }),
  }
}
