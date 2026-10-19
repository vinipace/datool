import { sql } from "drizzle-orm"
import { teamInputSchema } from "@/src/lib/build/contracts"
import type { TracerDatabase } from "./tracer/db"
import { TracerError } from "./tracer/errors"
import { iso } from "./build/operations/database"

/** The caller must authorize membership in this organization before invoking this service. */
export type OrganizationTeamContext = {
  database: TracerDatabase
  organizationId: string
}

type TeamRow = {
  id: string
  organization_id: string
  name: string
  description: string
  enabled: boolean
  created_at: unknown
  updated_at: unknown
}
type OperationsExecutor = Pick<TracerDatabase, "execute">

function team(row: TeamRow, memberCount = 0, memberIds: string[] = []) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    memberCount,
    memberIds,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  }
}

async function replaceTeamMembers(
  executor: OperationsExecutor,
  organizationId: string,
  teamId: string,
  memberIds: string[]
) {
  const ids = [...new Set(memberIds)]
  const encodedIds = sql`array[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`
  const members = await executor.execute<{ user_id: string }>(sql`
    select "userId" as user_id from member where "organizationId"=${organizationId} and "userId"=any(${encodedIds})
  `)
  if (new Set(members.rows.map((member) => member.user_id)).size !== ids.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Every team member must belong to this organization."
    )
  await executor.execute(
    sql`delete from build_team_members where organization_id=${organizationId} and team_id=${teamId} and not(user_id=any(${encodedIds}))`
  )
  if (ids.length)
    await executor.execute(sql`
    insert into build_team_members(organization_id,team_id,user_id)
    select ${organizationId},${teamId},unnest(${encodedIds})
    on conflict (organization_id,team_id,user_id) do nothing
  `)
}

export async function createOrganizationTeam(
  ctx: OrganizationTeamContext,
  value: unknown
) {
  const input = teamInputSchema.strict().parse(value)
  const id = `team_${crypto.randomUUID()}`
  return ctx.database.transaction(async (tx) => {
    const result = await tx.execute<TeamRow>(sql`
      insert into build_teams(id,organization_id,name,description,enabled)
      values (${id},${ctx.organizationId},${input.name},${input.description},${input.enabled})
      on conflict (organization_id,lower(name)) do nothing returning *
    `)
    const row = result.rows[0]
    if (!row)
      throw new TracerError(
        "CONFLICT",
        "A team with this name already exists in your organization."
      )
    const memberIds = [...new Set(input.memberIds ?? [])]
    await replaceTeamMembers(tx, ctx.organizationId, id, memberIds)
    return team(row, memberIds.length, memberIds)
  })
}

export async function updateOrganizationTeam(
  ctx: OrganizationTeamContext,
  id: string,
  value: unknown
) {
  const input = teamInputSchema.partial().strict().parse(value)
  return ctx.database
    .transaction(async (tx) => {
      const result = await tx.execute<TeamRow>(sql`
      update build_teams set name=coalesce(${input.name ?? null},name),description=coalesce(${input.description ?? null},description),enabled=coalesce(${input.enabled ?? null},enabled),updated_at=now()
      where organization_id=${ctx.organizationId} and id=${id} returning *
    `)
      const row = result.rows[0]
      if (!row)
        throw new TracerError(
          "NOT_FOUND",
          "Team was not found in this organization."
        )
      if (input.memberIds !== undefined)
        await replaceTeamMembers(tx, ctx.organizationId, id, input.memberIds)
      const members = await tx.execute<{ user_id: string }>(
        sql`select user_id from build_team_members where organization_id=${ctx.organizationId} and team_id=${id}`
      )
      return team(
        row,
        members.rows.length,
        members.rows.map((member) => member.user_id)
      )
    })
    .catch((error: unknown) => {
      let cause = error
      while (cause instanceof Error) {
        if ("code" in cause && cause.code === "23505")
          throw new TracerError(
            "CONFLICT",
            "A team with this name already exists in your organization."
          )
        cause = cause.cause
      }
      throw error
    })
}

export async function listOrganizationTeams(ctx: OrganizationTeamContext) {
  const result = await ctx.database.execute<
    TeamRow & { member_ids: string[] }
  >(sql`
    select t.*,coalesce(array_agg(m.user_id) filter (where om.id is not null),'{}'::text[]) as member_ids
    from build_teams t
    left join build_team_members m on m.organization_id=t.organization_id and m.team_id=t.id
    left join member om on om."organizationId"=t.organization_id and om."userId"=m.user_id
    where t.organization_id=${ctx.organizationId} group by t.id order by t.name asc
  `)
  return result.rows.map((row) =>
    team(row, row.member_ids.length, row.member_ids)
  )
}

export async function listTeamCandidates(ctx: OrganizationTeamContext) {
  const result = await ctx.database.execute<{
    id: string
    name: string
    image: string | null
    email: string
  }>(sql`
    select u.id,u.name,u.image,u.email from member m join "user" u on u.id=m."userId"
    where m."organizationId"=${ctx.organizationId} order by u.name,u.id
  `)
  return result.rows
}
