import { createOrganizationTeam, updateOrganizationTeam, listOrganizationTeams, listTeamCandidates } from "@/src/server/organization-teams"
import { sql } from "drizzle-orm"
import { z } from "zod"

import {
  macroActionSchema,
  macroInputSchema,
  routingRuleInputSchema,
  ticketPrioritySchema,
  ticketStatusSchema,
} from "@/src/lib/build/contracts"
import type { BuildContext } from "../context"
import { operationId } from "../context"
import { decodeJson, iso, jsonValue, prepareOperations } from "./database"

type OperationsExecutor = Pick<BuildContext["database"], "execute">
type RoutingInput = { channel?: string; priority?: string; tags?: string[]; contactStatus?: string }
export type RoutingAssignment = { ruleId: string | null; teamId: string | null; assigneeUserId: string | null }

export async function createTeam(context: BuildContext, value: unknown) {
  return createOrganizationTeam(await prepareOperations(context), value)
}

export async function updateTeam(context: BuildContext, id: string, value: unknown) {
  return updateOrganizationTeam(await prepareOperations(context), id, value)
}

export async function listTeams(context: BuildContext) {
  return listOrganizationTeams(await prepareOperations(context))
}

export async function listOrganizationMembers(context: BuildContext) {
  return listTeamCandidates(await prepareOperations(context))
}

export async function setTeamMember(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ teamId: z.string().min(1).max(128), userId: z.string().min(1).max(128), role: z.enum(["agent", "lead", "manager"]).default("agent"), availability: z.enum(["online", "away", "offline"]).default("offline"), maxConcurrent: z.number().int().min(1).max(1000).default(10) }).strict().parse(value)
  const teamExists = await ctx.database.execute(sql`select 1 from build_teams where organization_id=${ctx.organizationId} and id=${input.teamId} and enabled=true`)
  if (!teamExists.rows[0]) throw new Error("Team is not enabled in this organization.")
  await assertProjectMember(ctx.database, ctx.projectId, input.userId)
  await ctx.database.execute(sql`insert into build_team_members(organization_id,team_id,user_id,role,availability,max_concurrent) values (${ctx.organizationId},${input.teamId},${input.userId},${input.role},${input.availability},${input.maxConcurrent}) on conflict (organization_id,team_id,user_id) do update set role=excluded.role,availability=excluded.availability,max_concurrent=excluded.max_concurrent,updated_at=now()`)
  return { organizationId: ctx.organizationId, ...input }
}

export async function setAgentAvailability(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ userId: z.string().min(1).max(128), availability: z.enum(["online", "away", "offline"]) }).strict().parse(value)
  await assertProjectMember(ctx.database, ctx.projectId, input.userId)
  const result = await ctx.database.execute(sql`update build_team_members set availability=${input.availability},updated_at=now() where organization_id=${ctx.organizationId} and user_id=${input.userId}`)
  return { organizationId: ctx.organizationId, userId: input.userId, availability: input.availability, updatedMemberships: result.rowCount ?? 0 }
}

type RoutingRow = { id: string; project_id: string; name: string; priority: number; enabled: boolean; conditions_json: unknown; team_id: string | null; assignee_user_id: string | null; created_at: unknown; updated_at: unknown }

function routing(row: RoutingRow) {
  return { id: row.id, projectId: row.project_id, name: row.name, priority: row.priority, enabled: row.enabled, conditions: decodeJson<Record<string, unknown>>(row.conditions_json, {}), teamId: row.team_id, assigneeUserId: row.assignee_user_id, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }
}

export async function createRoutingRule(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = routingRuleInputSchema.strict().parse(value)
  const id = operationId("routing")
  if (!input.teamId && !input.assigneeUserId) throw new Error("A routing rule needs a teamId or assigneeUserId.")
  await assertTicketAssignment(ctx.database, ctx.projectId, { teamId: input.teamId, assigneeUserId: input.assigneeUserId })
  await ctx.database.execute(sql`insert into build_routing_rules(id,project_id,name,priority,enabled,conditions_json,team_id,assignee_user_id) values (${id},${ctx.projectId},${input.name},${input.priority},${input.enabled},${jsonValue(input.conditions)},${input.teamId},${input.assigneeUserId})`)
  const result = await ctx.database.execute<RoutingRow>(sql`select * from build_routing_rules where project_id=${ctx.projectId} and id=${id}`)
  const row = result.rows[0]
  if (!row) throw new Error("Routing rule could not be created.")
  return routing(row)
}

export async function listRoutingRules(context: BuildContext) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<RoutingRow>(sql`select * from build_routing_rules where project_id=${ctx.projectId} order by priority asc,id asc limit 500`)
  return result.rows.map(routing)
}

function conditionsMatch(conditions: Record<string, unknown>, input: { channel?: string; priority?: string; tags?: string[]; contactStatus?: string }) {
  if (conditions.channel && conditions.channel !== input.channel) return false
  if (conditions.priority && conditions.priority !== input.priority) return false
  if (conditions.contactStatus && conditions.contactStatus !== input.contactStatus) return false
  if (Array.isArray(conditions.tags) && !(conditions.tags as unknown[]).every((tag) => input.tags?.includes(String(tag)))) return false
  return true
}

async function assertProjectMember(executor: OperationsExecutor, projectId: string, userId: string) {
  const result = await executor.execute(sql`
    select 1
    from project p
    join member m on m."organizationId"=p.organization_id and m."userId"=${userId}
    where p.id=${projectId}
    limit 1
  `)
  if (!result.rows[0]) throw new Error(`User '${userId}' is not a member of this project's organization.`)
}

/** Validates explicit ticket assignment targets without trusting caller IDs. */
export async function assertTicketAssignment(
  executor: OperationsExecutor,
  projectId: string,
  assignment: { teamId: string | null; assigneeUserId: string | null },
) {
  if (assignment.teamId) {
    const team = await executor.execute(sql`select 1 from build_teams where organization_id=(select organization_id from project where id=${projectId}) and id=${assignment.teamId} and enabled=true`)
    if (!team.rows[0]) throw new Error(`Team '${assignment.teamId}' is not enabled.`)
  }
  if (!assignment.assigneeUserId) return
  await assertProjectMember(executor, projectId, assignment.assigneeUserId)
  if (assignment.teamId) {
    const member = await executor.execute(sql`
      select 1 from build_team_members
      where organization_id=(select organization_id from project where id=${projectId}) and team_id=${assignment.teamId} and user_id=${assignment.assigneeUserId}
      limit 1
    `)
    if (!member.rows[0]) throw new Error(`User '${assignment.assigneeUserId}' is not a member of team '${assignment.teamId}'.`)
  }
}

type AvailableMemberRow = { team_id: string; user_id: string; assigned_count: number; max_concurrent: number }

async function findAvailableMember(
  executor: OperationsExecutor,
  projectId: string,
  teamId: string | null,
  assigneeUserId: string | null,
) {
  const result = await executor.execute<AvailableMemberRow>(sql`
    select m.team_id,m.user_id,m.max_concurrent,
      (
        select count(*)::int
        from build_inbox_tickets t
        where t.project_id in (select id from project where organization_id=m.organization_id)
          and t.assignee_user_id=m.user_id
          and t.status in ('open','pending','snoozed')
      ) as assigned_count
    from build_team_members m
    join build_teams t on t.organization_id=m.organization_id and t.id=m.team_id and t.enabled=true
    join project p on p.id=${projectId} and p.organization_id=m.organization_id
    join member org_member on org_member."organizationId"=p.organization_id and org_member."userId"=m.user_id
    where m.organization_id=p.organization_id
      and m.availability in ('online','away')
      ${teamId ? sql`and m.team_id=${teamId}` : sql``}
      ${assigneeUserId ? sql`and m.user_id=${assigneeUserId}` : sql``}
      and (
        select count(*)::int
        from build_inbox_tickets t2
        where t2.project_id in (select id from project where organization_id=m.organization_id)
          and t2.assignee_user_id=m.user_id
          and t2.status in ('open','pending','snoozed')
      ) < m.max_concurrent
    order by assigned_count asc,m.updated_at asc,m.user_id asc
    limit 1
    for update of m
  `)
  return result.rows[0] ?? null
}

/** Resolves a route while refusing offline, over-capacity, or foreign users. */
export async function resolveRoutingWithExecutor(
  executor: OperationsExecutor,
  projectId: string,
  input: RoutingInput,
): Promise<RoutingAssignment> {
  const rules = await executor.execute<RoutingRow>(sql`select * from build_routing_rules where project_id=${projectId} order by priority asc,id asc limit 500`)
  for (const rule of rules.rows) {
    if (!rule.enabled || !conditionsMatch(decodeJson<Record<string, unknown>>(rule.conditions_json, {}), input)) continue
    if (rule.team_id) {
      const team = await executor.execute(sql`select 1 from build_teams where organization_id=(select organization_id from project where id=${projectId}) and id=${rule.team_id} and enabled=true`)
      if (!team.rows[0]) continue
    }
    const member = await findAvailableMember(executor, projectId, rule.team_id, rule.assignee_user_id)
    if (rule.assignee_user_id && !member) {
      return { ruleId: rule.id, teamId: rule.team_id, assigneeUserId: null }
    }
    return {
      ruleId: rule.id,
      teamId: rule.team_id ?? member?.team_id ?? null,
      assigneeUserId: member?.user_id ?? null,
    }
  }
  return { ruleId: null, teamId: null, assigneeUserId: null }
}

/** Resolves the first enabled rule and returns a concrete assignment. */
export async function resolveRouting(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ channel: z.string().max(80).optional(), priority: z.string().max(40).optional(), tags: z.array(z.string().max(80)).default([]), contactStatus: z.string().max(40).optional() }).strict().parse(value ?? {})
  return resolveRoutingWithExecutor(ctx.database, ctx.projectId, input)
}

type MacroRow = { id: string; project_id: string; name: string; body: string; actions_json: unknown; enabled: boolean; created_at: unknown; updated_at: unknown }
function macro(row: MacroRow) { return { id: row.id, projectId: row.project_id, name: row.name, body: row.body, actions: decodeJson<unknown[]>(row.actions_json, []), enabled: row.enabled, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) } }

export async function createMacro(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = macroInputSchema.strict().parse(value)
  const id = operationId("macro")
  await ctx.database.execute(sql`insert into build_macros(id,project_id,name,body,actions_json,enabled) values (${id},${ctx.projectId},${input.name},${input.body},${jsonValue(input.actions)},${input.enabled})`)
  const result = await ctx.database.execute<MacroRow>(sql`select * from build_macros where project_id=${ctx.projectId} and id=${id}`)
  const row = result.rows[0]
  if (!row) throw new Error("Macro could not be created.")
  return macro(row)
}

export async function updateMacro(context: BuildContext, id: string, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = macroInputSchema.partial().strict().parse(value)
  await ctx.database.execute(sql`update build_macros set name=coalesce(${input.name ?? null},name),body=coalesce(${input.body ?? null},body),actions_json=coalesce(${input.actions ? jsonValue(input.actions) : sql`null`},actions_json),enabled=coalesce(${input.enabled ?? null},enabled),updated_at=now() where project_id=${ctx.projectId} and id=${id}`)
  const result = await ctx.database.execute<MacroRow>(sql`select * from build_macros where project_id=${ctx.projectId} and id=${id}`)
  const row = result.rows[0]
  if (!row) throw new Error(`Macro '${id}' was not found.`)
  return macro(row)
}

export async function listMacros(context: BuildContext) {
  const ctx = await prepareOperations(context)
  const result = await ctx.database.execute<MacroRow>(sql`select * from build_macros where project_id=${ctx.projectId} order by name asc limit 500`)
  return result.rows.map(macro)
}

type MacroTicketRow = {
  id: string
  status: string
  priority: string
  tags_json: unknown
  assignee_user_id: string | null
  team_id: string | null
  snooze_until: unknown
  version: number
}

/** Applies only bounded ticket-state actions; provider sends remain explicit. */
export async function applyMacro(context: BuildContext, value: unknown) {
  const ctx = await prepareOperations(context)
  const input = z.object({ macroId: z.string().trim().min(1).max(128), ticketId: z.string().trim().min(1).max(128), expectedVersion: z.number().int().positive() }).strict().parse(value)
  return ctx.database.transaction(async (tx) => {
    const macroResult = await tx.execute<MacroRow>(sql`select * from build_macros where project_id=${ctx.projectId} and id=${input.macroId} for update`)
    const macroRow = macroResult.rows[0]
    if (!macroRow) throw new Error(`Macro '${input.macroId}' was not found.`)
    if (!macroRow.enabled) throw new Error(`Macro '${input.macroId}' is disabled.`)
    const actions = z.array(macroActionSchema).max(50).parse(decodeJson<unknown[]>(macroRow.actions_json, []))
    const ticketResult = await tx.execute<MacroTicketRow>(sql`
      select id,status,priority,tags_json,assignee_user_id,team_id,snooze_until,version
      from build_inbox_tickets
      where project_id=${ctx.projectId} and id=${input.ticketId}
      for update
    `)
    const current = ticketResult.rows[0]
    if (!current) throw new Error(`Inbox ticket '${input.ticketId}' was not found.`)
    if (current.version !== input.expectedVersion) throw new Error("The ticket changed. Reload it before applying this macro.")

    let status = ticketStatusSchema.parse(current.status)
    let priority = ticketPrioritySchema.parse(current.priority)
    const tags = new Set(decodeJson<string[]>(current.tags_json, []))
    let teamId = current.team_id
    let assigneeUserId = current.assignee_user_id
    let snoozeUntil = current.snooze_until == null ? null : new Date(String(current.snooze_until)).toISOString()
    for (const action of actions) {
      switch (action.type) {
        case "set_status":
          status = action.status
          break
        case "set_priority":
          priority = action.priority
          break
        case "add_tag":
          tags.add(action.tag)
          break
        case "remove_tag":
          tags.delete(action.tag)
          break
        case "assign_team":
          teamId = action.teamId
          break
        case "assign_user":
          assigneeUserId = action.userId
          break
        case "clear_assignment":
          teamId = null
          assigneeUserId = null
          break
        case "snooze_until":
          status = "snoozed"
          snoozeUntil = action.snoozeUntil
          break
      }
    }
    await assertTicketAssignment(tx, ctx.projectId, { teamId, assigneeUserId })
    const updated = await tx.execute<MacroTicketRow>(sql`
      update build_inbox_tickets
      set status=${status},priority=${priority},tags_json=${jsonValue([...tags])},team_id=${teamId},assignee_user_id=${assigneeUserId},snooze_until=${snoozeUntil},resolved_at=case when ${status} in ('solved','closed') then coalesce(resolved_at,now()) else null end,version=version+1,updated_at=now()
      where project_id=${ctx.projectId} and id=${input.ticketId} and version=${input.expectedVersion}
      returning id,status,priority,tags_json,assignee_user_id,team_id,snooze_until,version
    `)
    const row = updated.rows[0]
    if (!row) throw new Error("The ticket changed. Reload it before applying this macro.")
    await tx.execute(sql`
      insert into build_ticket_events(id,project_id,ticket_id,event_type,actor_id,payload_json)
      values (${operationId("ticket_event")},${ctx.projectId},${input.ticketId},'macro_applied',${ctx.actorId ?? null},${jsonValue({ macroId: input.macroId, actions })})
    `)
    return {
      projectId: ctx.projectId,
      ticketId: row.id,
      macroId: input.macroId,
      status: ticketStatusSchema.parse(row.status),
      priority: ticketPrioritySchema.parse(row.priority),
      tags: decodeJson<string[]>(row.tags_json, []),
      teamId: row.team_id,
      assigneeUserId: row.assignee_user_id,
      snoozeUntil: row.snooze_until == null ? null : new Date(String(row.snooze_until)).toISOString(),
      version: row.version,
    }
  })
}
