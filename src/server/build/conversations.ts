import { randomUUID } from "node:crypto"

import { sql } from "drizzle-orm"

import {
  agentAppearanceSchema,
  type BuildChannel,
} from "@/src/lib/build/contracts"
import type { TracerDatabase } from "@/src/server/tracer/db"
import { getTracerProjectId } from "@/src/server/tracer/db"
import type { BuildContext } from "./context"
import { getAgent } from "./agents"
import { ensureEscalationTicket } from "./operations/ticket-escalation"
import {
  appendConversationMessageInputSchema,
  conversationContentSchema,
  conversationMetadataSchema,
  conversationMessageRoleSchema,
  conversationStatusSchema,
  conversationToolStatusSchema,
  conversationTurnStatusSchema,
  createConversationInputSchema,
  listConversationsInputSchema,
  startConversationTurnInputSchema,
  type AppendConversationMessageInput,
  type Conversation,
  type ConversationMessage,
  type ConversationOwnerType,
  type ConversationToolCall,
  type ConversationTurn,
  type ConversationTurnStatus,
  type CreateConversationInput,
  type StartConversationTurnInput,
  type TurnAdmission,
} from "./conversation-schema"

/** Conversation operations use the same explicit tenant context as all Build APIs. */
export type ConversationContext = BuildContext

const TURN_LOCK_MS = 2 * 60 * 1000
const agentAvatarSchema = agentAppearanceSchema.pick({
  avatarUrl: true,
  avatarStyle: true,
  avatarColor: true,
})

function now() {
  return new Date().toISOString()
}

function json(value: unknown) {
  return JSON.stringify(value === undefined ? null : value)
}

function parseJson<T>(value: unknown, fallback: T): T {
  try {
    if (typeof value !== "string") return (value ?? fallback) as T
    const parsed = JSON.parse(value)
    return (parsed ?? fallback) as T
  } catch {
    // node-postgres parses json/jsonb values before returning them. Scalar
    // strings therefore arrive as plain text rather than JSON source.
    return (value ?? fallback) as T
  }
}

function asObject(value: unknown): Record<string, unknown> {
  const parsed = parseJson<unknown>(value, {})
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
}

function requireProject(database: TracerDatabase, projectId: string) {
  const bound = getTracerProjectId(database)
  if (bound !== projectId)
    throw new Error("Build conversation access is bound to another project.")
}

function toConversation(row: Record<string, unknown>): Conversation {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    agentId: String(row.agent_id),
    channel: String(row.channel) as BuildChannel,
    externalConversationId:
      row.external_conversation_id === null ||
      row.external_conversation_id === undefined
        ? null
        : String(row.external_conversation_id),
    status: conversationStatusSchema.parse(row.status),
    ownerType: (row.owner_type === "human"
      ? "human"
      : "ai") as ConversationOwnerType,
    ownerId:
      row.owner_id === null || row.owner_id === undefined
        ? null
        : String(row.owner_id),
    ownerFence: Number(row.owner_fence ?? 0),
    turnSequence: Number(row.turn_sequence ?? 0),
    metadata: conversationMetadataSchema.parse(asObject(row.metadata_json)),
    variables: asObject(row.variables_json),
    lastMessageAt: row.last_message_at
      ? new Date(String(row.last_message_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  }
}

function toMessage(row: Record<string, unknown>): ConversationMessage {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    turnId:
      row.turn_id === null || row.turn_id === undefined
        ? null
        : String(row.turn_id),
    ordinal: Number(row.ordinal),
    role: conversationMessageRoleSchema.parse(row.role),
    // PostgreSQL already decodes JSONB. Parsing message text again would turn
    // replies such as "3", "true", or JSON examples into different values.
    content: conversationContentSchema.parse(row.content_json ?? ""),
    toolCallId:
      row.tool_call_id === null || row.tool_call_id === undefined
        ? null
        : String(row.tool_call_id),
    actionId:
      row.action_id === null || row.action_id === undefined
        ? null
        : String(row.action_id),
    status: (row.status ?? "completed") as ConversationMessage["status"],
    metadata: conversationMetadataSchema.parse(asObject(row.metadata_json)),
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at
      ? new Date(String(row.completed_at)).toISOString()
      : null,
  }
}

function toTurn(row: Record<string, unknown>): ConversationTurn {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    requestKey: String(row.request_key),
    sourceEventId:
      row.source_event_id === null || row.source_event_id === undefined
        ? null
        : String(row.source_event_id),
    status: conversationTurnStatusSchema.parse(row.status),
    inputMessageId:
      row.input_message_id === null || row.input_message_id === undefined
        ? null
        : String(row.input_message_id),
    outputMessageId:
      row.output_message_id === null || row.output_message_id === undefined
        ? null
        : String(row.output_message_id),
    traceId:
      row.trace_id === null || row.trace_id === undefined
        ? null
        : String(row.trace_id),
    sessionId:
      row.session_id === null || row.session_id === undefined
        ? null
        : String(row.session_id),
    snapshot: asObject(row.snapshot_json),
    usage: asObject(row.usage_json),
    error:
      row.error_json === null || row.error_json === undefined
        ? null
        : asObject(row.error_json),
    ownerFence: Number(row.owner_fence ?? 0),
    lockExpiresAt: row.lock_expires_at
      ? new Date(String(row.lock_expires_at)).toISOString()
      : null,
    createdAt: new Date(String(row.created_at)).toISOString(),
    startedAt: row.started_at
      ? new Date(String(row.started_at)).toISOString()
      : null,
    completedAt: row.completed_at
      ? new Date(String(row.completed_at)).toISOString()
      : null,
  }
}

function toToolCall(row: Record<string, unknown>): ConversationToolCall {
  return {
    id: String(row.id),
    projectId: String(row.project_id),
    conversationId: String(row.conversation_id),
    turnId: String(row.turn_id),
    toolCallId: String(row.tool_call_id),
    actionId: String(row.action_id),
    status: conversationToolStatusSchema.parse(row.status),
    input: asObject(row.input_json),
    output:
      row.output_json === null || row.output_json === undefined
        ? null
        : parseJson(row.output_json, null),
    error:
      row.error_json === null || row.error_json === undefined
        ? null
        : asObject(row.error_json),
    continuation:
      row.continuation_json === null || row.continuation_json === undefined
        ? null
        : asObject(row.continuation_json),
    createdAt: new Date(String(row.created_at)).toISOString(),
    completedAt: row.completed_at
      ? new Date(String(row.completed_at)).toISOString()
      : null,
  }
}

export class ConversationBusyError extends Error {
  readonly code = "CONVERSATION_BUSY"
  constructor(readonly turnId: string) {
    super("A turn is already running for this conversation.")
    this.name = "ConversationBusyError"
  }
}

export class ConversationHumanOwnedError extends Error {
  readonly code = "CONVERSATION_HUMAN_OWNED"
  constructor(readonly conversationId: string) {
    super("A human currently owns this conversation.")
    this.name = "ConversationHumanOwnedError"
  }
}

export class ConversationOwnershipLostError extends Error {
  readonly code = "CONVERSATION_OWNERSHIP_LOST"
  constructor(readonly turnId: string) {
    super("Conversation ownership changed while the turn was running.")
    this.name = "ConversationOwnershipLostError"
  }
}

export class ConversationNotFoundError extends Error {
  readonly code = "CONVERSATION_NOT_FOUND"
  constructor(readonly conversationId: string) {
    super(`Conversation '${conversationId}' was not found in this project.`)
    this.name = "ConversationNotFoundError"
  }
}

export type ConversationServiceOptions = {
  lockMs?: number
  id?: () => string
  now?: () => string
}

export type ConversationTurnAdmissionStats = {
  requestsLastMinute: number
  concurrentTurns: number
  turnsToday: number
  spendTodayUsd: number
}

export type ConversationBudgetReservation = {
  reservationId: string
  estimatedUsd: number
  status: "reserved" | "settled" | "released" | "uncertain"
}

export class ConversationBudgetExceededError extends Error {
  readonly code = "DAILY_BUDGET_EXCEEDED"
  constructor() {
    super("The agent daily budget has been reached.")
    this.name = "ConversationBudgetExceededError"
  }
}

/**
 * Durable customer conversation storage. Every query carries project scope;
 * the bound TracerDatabase is checked before the first operation to prevent a
 * caller accidentally mixing an MCP-selected project with another database.
 */
export class ConversationService {
  private readonly projectId: string
  private readonly lockMs: number
  private readonly makeId: () => string
  private readonly clock: () => string

  constructor(
    private readonly context: ConversationContext,
    options: ConversationServiceOptions = {}
  ) {
    requireProject(context.database, context.projectId)
    this.projectId = context.projectId
    this.lockMs = options.lockMs ?? TURN_LOCK_MS
    this.makeId = options.id ?? randomUUID
    this.clock = options.now ?? now
  }

  private get database() {
    return this.context.database
  }

  private currentTime() {
    return this.clock()
  }

  async get(id: string): Promise<Conversation | null> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversations
      WHERE project_id = ${this.projectId} AND id = ${id}
      LIMIT 1
    `)
    return result.rows[0] ? toConversation(result.rows[0]) : null
  }

  async require(id: string): Promise<Conversation> {
    const conversation = await this.get(id)
    if (!conversation) throw new ConversationNotFoundError(id)
    return conversation
  }

  async list(value: unknown = {}) {
    const input = listConversationsInputSchema.parse(value)
    const result = await this.database.execute<Record<string, unknown>>(sql`
      select c.*,a.name as agent_name,
        a.current_config_json->'appearance' as agent_appearance,
        contact.display_name as contact_name,contact.id as contact_id,
        t.id as ticket_id,t.version as ticket_version,t.status as ticket_status,
        coalesce(nullif(t.subject,''),preview.subject,'') as subject
      from build_conversations c
      left join build_agents a on a.project_id=c.project_id and a.id=c.agent_id
      left join build_inbox_tickets t on t.project_id=c.project_id and t.conversation_id=c.id
      left join build_contacts contact on contact.project_id=c.project_id
        and contact.id=coalesce(t.contact_id,c.metadata_json->>'contactId')
      left join lateral (
        select coalesce(
          (select m.content_json #>> '{}' from build_conversation_messages m
           where m.project_id=c.project_id and m.conversation_id=c.id
             and m.role='user' and jsonb_typeof(m.content_json)='string'
           order by m.ordinal asc limit 1),
          (select m.content_json->>'text' from build_channel_message m
           where m.project_id=c.project_id and m.conversation_id=c.id and m.direction='inbound'
           order by m.created_at asc,m.id asc limit 1)
        ) as subject
      ) preview on true
      where c.project_id=${this.projectId}
        ${input.agentId ? sql`and c.agent_id=${input.agentId}` : sql``}
        ${input.cursor ? sql`and c.id>${input.cursor}` : sql``}
        ${input.status ? sql`and c.status=${input.status}` : sql``}
        ${input.channel ? sql`and c.channel=${input.channel}` : sql``}
        ${
          input.search
            ? sql`and (
          c.id ilike ${`%${input.search}%`} or c.external_conversation_id ilike ${`%${input.search}%`}
          or coalesce(nullif(t.subject,''),preview.subject,'') ilike ${`%${input.search}%`}
          or contact.display_name ilike ${`%${input.search}%`}
          or contact.email ilike ${`%${input.search}%`} or contact.phone ilike ${`%${input.search}%`}
        )`
            : sql``
        }
      order by c.id asc limit ${input.limit + 1}
    `)
    const rows = result.rows.slice(0, input.limit)
    return {
      items: rows.map((row) => ({
        ...toConversation(row),
        agentName: row.agent_name as string | null,
        agentAvatar: agentAvatarSchema.parse(row.agent_appearance ?? {}),
        subject: String(row.subject ?? "").slice(0, 500),
        contactId: row.contact_id as string | null,
        contactName: row.contact_name as string | null,
        ticketId: row.ticket_id as string | null,
        ticketVersion: row.ticket_version as number | null,
        ticketStatus: row.ticket_status as string | null,
      })),
      nextCursor:
        result.rows.length > input.limit ? String(rows.at(-1)!.id) : null,
    }
  }

  async getByExternalId(
    agentId: string,
    channel: BuildChannel,
    externalConversationId: string
  ): Promise<Conversation | null> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversations
      WHERE project_id = ${this.projectId} AND agent_id = ${agentId}
        AND channel = ${channel} AND external_conversation_id = ${externalConversationId}
      LIMIT 1
    `)
    return result.rows[0] ? toConversation(result.rows[0]) : null
  }

  async getOrCreate(input: CreateConversationInput): Promise<Conversation> {
    const parsed = createConversationInputSchema.parse(input)
    // The composite FK below protects writes at the database boundary. Resolve
    // the active agent here as well so callers receive a stable application
    // error before opening a transaction, and archived agents cannot receive
    // new customer conversations.
    await getAgent(this.context, parsed.agentId)
    return this.database.transaction(async (tx) => {
      if (parsed.externalConversationId) {
        const existing = await tx.execute<Record<string, unknown>>(sql`
          SELECT * FROM build_conversations
          WHERE project_id = ${this.projectId} AND agent_id = ${parsed.agentId}
            AND channel = ${parsed.channel}
            AND external_conversation_id = ${parsed.externalConversationId}
          LIMIT 1 FOR UPDATE
        `)
        if (existing.rows[0]) return toConversation(existing.rows[0])
      }
      const id = this.makeId()
      const result = await tx.execute<Record<string, unknown>>(sql`
        INSERT INTO build_conversations
          (id, project_id, agent_id, channel, external_conversation_id, metadata_json)
        VALUES
          (${id}, ${this.projectId}, ${parsed.agentId}, ${parsed.channel},
           ${parsed.externalConversationId ?? null}, ${json(parsed.metadata)}::jsonb)
        ON CONFLICT (project_id, agent_id, channel, external_conversation_id)
          WHERE external_conversation_id IS NOT NULL
        DO UPDATE SET updated_at = build_conversations.updated_at
        RETURNING *
      `)
      if (!result.rows[0]) throw new Error("Unable to create a conversation.")
      return toConversation(result.rows[0])
    })
  }

  async listMessages(
    conversationId: string,
    options: { limit?: number; before?: string } = {}
  ): Promise<{ items: ConversationMessage[]; nextCursor: string | null }> {
    await this.require(conversationId)
    const limit = Math.max(1, Math.min(options.limit ?? 100, 200))
    const before = options.before
      ? await this.database.execute<{ ordinal: number }>(sql`
          SELECT ordinal FROM build_conversation_messages
          WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
            AND id = ${options.before}
          LIMIT 1
        `)
      : null
    const beforeOrdinal = before?.rows[0]?.ordinal
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversation_messages
      WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
        ${beforeOrdinal === undefined ? sql`` : sql`AND ordinal < ${beforeOrdinal}`}
      ORDER BY ordinal DESC
      LIMIT ${limit + 1}
    `)
    const rows = result.rows.slice(0, limit).reverse().map(toMessage)
    return {
      items: rows,
      nextCursor: result.rows.length > limit ? (rows[0]?.id ?? null) : null,
    }
  }

  async listToolCalls(conversationId: string): Promise<ConversationToolCall[]> {
    await this.require(conversationId)
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversation_tool_calls
      WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
      ORDER BY created_at, id
    `)
    return result.rows.map(toToolCall)
  }

  async appendMessage(
    conversationId: string,
    input: AppendConversationMessageInput,
    options: { database?: TracerDatabase; ownerFence?: number } = {}
  ): Promise<ConversationMessage> {
    const parsed = appendConversationMessageInputSchema.parse(input)
    const database = options.database ?? this.database
    const conversation = await this.require(conversationId)
    void conversation
    const id = this.makeId()
    const result = await database.execute<Record<string, unknown>>(sql`
      INSERT INTO build_conversation_messages
        (id, project_id, conversation_id, turn_id, role, content_json,
         tool_call_id, action_id, status, metadata_json, completed_at)
      SELECT
        ${id}, ${this.projectId}, ${conversationId}, ${parsed.turnId ?? null},
        ${parsed.role}, ${json(parsed.content)}::jsonb,
        ${parsed.toolCallId ?? null}, ${parsed.actionId ?? null}, ${parsed.status},
        ${json(parsed.metadata)}::jsonb,
        CASE WHEN ${parsed.status} = 'pending' THEN NULL ELSE now() END
      WHERE EXISTS (
        SELECT 1 FROM build_conversations c
        WHERE c.project_id = ${this.projectId} AND c.id = ${conversationId}
          ${options.ownerFence === undefined ? sql`` : sql`AND c.owner_fence = ${options.ownerFence}`}
          AND (
            ${
              parsed.turnId === undefined
                ? sql`TRUE`
                : sql`EXISTS (
                SELECT 1 FROM build_conversation_turns t
                WHERE t.project_id = c.project_id
                  AND t.id = ${parsed.turnId}
                  AND t.conversation_id = c.id
                  AND t.owner_fence = c.owner_fence
              )`
            }
          )
      )
      RETURNING *
    `)
    if (!result.rows[0]) {
      if (options.ownerFence !== undefined)
        throw new ConversationOwnershipLostError(
          parsed.turnId ?? conversationId
        )
      throw new Error("Unable to append conversation message.")
    }
    await database.execute(sql`
      UPDATE build_conversations SET last_message_at = now(), updated_at = now()
      WHERE project_id = ${this.projectId} AND id = ${conversationId}
        ${options.ownerFence === undefined ? sql`` : sql`AND owner_fence = ${options.ownerFence}`}
    `)
    return toMessage(result.rows[0])
  }

  /**
   * Admit one inbound event. The row lock and unique request key make retries
   * safe, while the short lease prevents a crashed worker from wedging a chat.
   * A late worker must still present the owner fence when committing output.
   */
  async startTurn(
    conversationId: string,
    input: StartConversationTurnInput
  ): Promise<TurnAdmission> {
    const parsed = startConversationTurnInputSchema.parse(input)
    const lockUntil = new Date(
      new Date(this.currentTime()).getTime() + this.lockMs
    ).toISOString()
    return this.database.transaction(async (tx) => {
      const conversationResult = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversations
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
        LIMIT 1 FOR UPDATE
      `)
      if (!conversationResult.rows[0])
        throw new ConversationNotFoundError(conversationId)
      const conversation = toConversation(conversationResult.rows[0])
      const existingResult = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversation_turns
        WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
          AND request_key = ${parsed.requestKey}
        LIMIT 1
      `)
      if (existingResult.rows[0]) {
        const existing = toTurn(existingResult.rows[0])
        const output = existing.outputMessageId
          ? await tx.execute<Record<string, unknown>>(sql`
              SELECT * FROM build_conversation_messages
              WHERE project_id = ${this.projectId} AND id = ${existing.outputMessageId}
              LIMIT 1
            `)
          : null
        if (
          existing.status === "completed" ||
          existing.status === "failed" ||
          existing.status === "cancelled" ||
          existing.status === "uncertain" ||
          existing.status === "awaiting_client"
        ) {
          return {
            kind: "replay",
            conversation,
            turn: existing,
            outputMessage: output?.rows[0] ? toMessage(output.rows[0]) : null,
            replay: true,
          }
        }
        return { kind: "busy", conversation, turn: existing, replay: false }
      }

      if (conversation.ownerType === "human")
        throw new ConversationHumanOwnedError(conversationId)

      const active = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversation_turns
        WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
          AND status IN ('started','running')
          AND (lock_expires_at IS NULL OR lock_expires_at > now())
        ORDER BY created_at DESC LIMIT 1
      `)
      if (active.rows[0])
        return {
          kind: "busy",
          conversation,
          turn: toTurn(active.rows[0]),
          replay: false,
        }

      const turnId = this.makeId()
      const inputMessageId = this.makeId()
      const nextOwnerFence = conversation.ownerFence + 1
      const advancedConversationResult = await tx.execute<
        Record<string, unknown>
      >(sql`
        UPDATE build_conversations
        SET owner_fence = ${nextOwnerFence}, updated_at = now()
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
          AND owner_type = 'ai' AND owner_fence = ${conversation.ownerFence}
        RETURNING *
      `)
      const admittedConversation = advancedConversationResult.rows[0]
        ? toConversation(advancedConversationResult.rows[0])
        : null
      if (!admittedConversation)
        throw new ConversationOwnershipLostError(conversationId)
      const turnResult = await tx.execute<Record<string, unknown>>(sql`
        INSERT INTO build_conversation_turns
          (id, project_id, conversation_id, request_key, source_event_id, status,
           input_message_id, snapshot_json, owner_fence, lock_expires_at,
           started_at)
        VALUES
          (${turnId}, ${this.projectId}, ${conversationId}, ${parsed.requestKey},
           ${parsed.sourceEventId ?? null}, 'running', ${inputMessageId},
           ${json(parsed.snapshot)}::jsonb, ${nextOwnerFence}, ${lockUntil}, now())
        RETURNING *
      `)
      const messageResult = await tx.execute<Record<string, unknown>>(sql`
        INSERT INTO build_conversation_messages
          (id, project_id, conversation_id, turn_id, role, content_json,
           status, metadata_json, completed_at)
        VALUES
          (${inputMessageId}, ${this.projectId}, ${conversationId}, ${turnId}, 'user',
           ${json(parsed.input)}::jsonb, 'completed', ${json(parsed.metadata)}::jsonb, now())
        RETURNING *
      `)
      await tx.execute(sql`
        UPDATE build_conversations
        SET turn_sequence = turn_sequence + 1,
            last_message_at = now(), updated_at = now()
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
      `)
      if (!turnResult.rows[0] || !messageResult.rows[0])
        throw new Error("Unable to admit conversation turn.")
      return {
        kind: "created",
        conversation: admittedConversation,
        turn: toTurn(turnResult.rows[0]),
        inputMessage: toMessage(messageResult.rows[0]),
        replay: false,
      }
    })
  }

  async getMessagesForModel(
    conversationId: string
  ): Promise<ConversationMessage[]> {
    const result = await this.listMessages(conversationId, { limit: 200 })
    return result.items
  }

  /**
   * Count usage from the authoritative ledger so per-agent guardrails apply
   * across every channel adapter and survive worker restarts. The current
   * admitted turn is included in each applicable count.
   */
  async getTurnAdmissionStats(
    agentId: string,
    at = this.currentTime()
  ): Promise<ConversationTurnAdmissionStats> {
    const nowDate = new Date(at)
    const minuteStart = new Date(nowDate.getTime() - 60_000).toISOString()
    const dayStart = new Date(
      Date.UTC(
        nowDate.getUTCFullYear(),
        nowDate.getUTCMonth(),
        nowDate.getUTCDate()
      )
    ).toISOString()
    const result = await this.database.execute<{
      requests_last_minute: string | number
      concurrent_turns: string | number
      turns_today: string | number
      spend_today_usd: string | number | null
    }>(sql`
      SELECT
        count(*) FILTER (WHERE t.created_at >= ${minuteStart}) AS requests_last_minute,
        count(*) FILTER (
          WHERE t.status IN ('started', 'running')
            AND (t.lock_expires_at IS NULL OR t.lock_expires_at > ${nowDate.toISOString()})
        ) AS concurrent_turns,
        count(*) FILTER (WHERE t.created_at >= ${dayStart}) AS turns_today,
        COALESCE(
          sum(
            CASE
              WHEN (t.usage_json->>'costUsd') ~ '^[0-9]+([.][0-9]+)?$'
                THEN (t.usage_json->>'costUsd')::numeric
              ELSE 0
            END
          ) FILTER (WHERE t.created_at >= ${dayStart}),
          0
        ) AS spend_today_usd
      FROM build_conversation_turns t
      JOIN build_conversations c
        ON c.project_id = t.project_id AND c.id = t.conversation_id
      WHERE t.project_id = ${this.projectId} AND c.agent_id = ${agentId}
    `)
    const row = result.rows[0]
    return {
      requestsLastMinute: Number(row?.requests_last_minute ?? 0),
      concurrentTurns: Number(row?.concurrent_turns ?? 0),
      turnsToday: Number(row?.turns_today ?? 0),
      spendTodayUsd: Number(row?.spend_today_usd ?? 0),
    }
  }

  /**
   * Atomically reserve a daily dollar budget for one admitted turn. Advisory
   * locking serializes reservations for an agent across conversations while
   * the unique turn key makes a retry return the existing reservation.
   */
  async reserveBudget(input: {
    agentId: string
    conversationId: string
    turnId: string
    ownerFence: number
    estimatedUsd: number
    dailyLimitUsd: number
    at?: string
  }): Promise<ConversationBudgetReservation> {
    if (!Number.isFinite(input.estimatedUsd) || input.estimatedUsd < 0)
      throw new Error("Budget estimates must be finite and non-negative.")
    if (!Number.isFinite(input.dailyLimitUsd) || input.dailyLimitUsd < 0)
      throw new Error("Daily budget must be finite and non-negative.")
    const at = input.at ?? this.currentTime()
    const dayStartDate = new Date(at)
    const dayStart = new Date(
      Date.UTC(
        dayStartDate.getUTCFullYear(),
        dayStartDate.getUTCMonth(),
        dayStartDate.getUTCDate()
      )
    ).toISOString()
    return this.database.transaction(async (tx) => {
      const existing = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversation_budget_reservations
        WHERE project_id = ${this.projectId}
          AND agent_id = ${input.agentId}
          AND conversation_id = ${input.conversationId}
          AND turn_id = ${input.turnId}
          AND owner_fence = ${input.ownerFence}
        LIMIT 1 FOR UPDATE
      `)
      if (existing.rows[0]) {
        const row = existing.rows[0]
        return {
          reservationId: String(row.id),
          estimatedUsd: Number(row.estimated_usd ?? 0),
          status: String(row.status) as ConversationBudgetReservation["status"],
        }
      }

      // hashtextextended is deterministic inside PostgreSQL and avoids making
      // the application invent a lock key from customer-controlled strings.
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(hashtextextended(
          ${`${this.projectId}:${input.agentId}`}, 0
        ))
      `)
      // A concurrent retry for the same turn may have waited on the advisory
      // lock while the first transaction inserted its reservation. Re-read
      // after serialization so it replays the existing admission instead of
      // incorrectly consuming the remaining budget or being rejected.
      const serializedExisting = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversation_budget_reservations
        WHERE project_id = ${this.projectId}
          AND agent_id = ${input.agentId}
          AND conversation_id = ${input.conversationId}
          AND turn_id = ${input.turnId}
          AND owner_fence = ${input.ownerFence}
        LIMIT 1 FOR UPDATE
      `)
      if (serializedExisting.rows[0]) {
        const row = serializedExisting.rows[0]
        return {
          reservationId: String(row.id),
          estimatedUsd: Number(row.estimated_usd ?? 0),
          status: String(row.status) as ConversationBudgetReservation["status"],
        }
      }
      const admission = await tx.execute<Record<string, unknown>>(sql`
        SELECT c.agent_id, c.owner_fence, t.owner_fence AS turn_owner_fence,
               t.status AS turn_status
        FROM build_conversations c
        JOIN build_conversation_turns t
          ON t.project_id = c.project_id AND t.conversation_id = c.id
        WHERE c.project_id = ${this.projectId}
          AND c.id = ${input.conversationId}
          AND c.agent_id = ${input.agentId}
          AND t.id = ${input.turnId}
        LIMIT 1
        FOR UPDATE
      `)
      const admissionRow = admission.rows[0]
      if (
        !admissionRow ||
        Number(admissionRow.owner_fence) !== input.ownerFence ||
        Number(admissionRow.turn_owner_fence) !== input.ownerFence ||
        !["started", "running"].includes(String(admissionRow.turn_status))
      )
        throw new ConversationOwnershipLostError(input.turnId)
      const totals = await tx.execute<{
        committed_usd: string | number | null
      }>(sql`
        SELECT
          COALESCE(sum(CASE
            WHEN r.status = 'settled' THEN r.actual_usd
            WHEN r.status IN ('reserved','uncertain') THEN r.estimated_usd
            ELSE 0
          END), 0) AS committed_usd
        FROM build_conversation_budget_reservations r
        WHERE r.project_id = ${this.projectId}
          AND r.agent_id = ${input.agentId}
          AND r.created_at >= ${dayStart}
      `)
      const committed = Number(totals.rows[0]?.committed_usd ?? 0)
      if (committed + input.estimatedUsd > input.dailyLimitUsd + 1e-12)
        throw new ConversationBudgetExceededError()

      const id = this.makeId()
      const inserted = await tx.execute<Record<string, unknown>>(sql`
        INSERT INTO build_conversation_budget_reservations
          (id, project_id, agent_id, conversation_id, turn_id, owner_fence,
           estimated_usd, status)
        VALUES
          (${id}, ${this.projectId}, ${input.agentId}, ${input.conversationId},
           ${input.turnId}, ${input.ownerFence}, ${input.estimatedUsd}, 'reserved')
        RETURNING *
      `)
      if (!inserted.rows[0]) throw new Error("Unable to reserve daily budget.")
      return {
        reservationId: id,
        estimatedUsd: input.estimatedUsd,
        status: "reserved",
      }
    })
  }

  /** Settle a reservation from measured provider usage or retain it as unknown. */
  async settleBudget(input: {
    reservationId: string
    ownerFence?: number
    actualUsd: number | null
    failed: boolean
  }): Promise<ConversationBudgetReservation | null> {
    if (
      input.actualUsd !== null &&
      (!Number.isFinite(input.actualUsd) || input.actualUsd < 0)
    )
      throw new Error("Measured budget usage must be finite and non-negative.")
    const status = input.failed
      ? "released"
      : input.actualUsd === null
        ? "uncertain"
        : "settled"
    const result = await this.database.execute<Record<string, unknown>>(sql`
      UPDATE build_conversation_budget_reservations
      SET status = ${status}, actual_usd = ${input.actualUsd}, settled_at = now()
      WHERE project_id = ${this.projectId} AND id = ${input.reservationId}
        AND status = 'reserved'
        ${input.ownerFence === undefined ? sql`` : sql`AND owner_fence = ${input.ownerFence}`}
      RETURNING *
    `)
    if (!result.rows[0]) return null
    const row = result.rows[0]
    return {
      reservationId: String(row.id),
      estimatedUsd: Number(row.estimated_usd ?? 0),
      status: String(row.status) as ConversationBudgetReservation["status"],
    }
  }

  async setTrace(
    turnId: string,
    traceId: string,
    sessionId: string,
    ownerFence: number
  ) {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      UPDATE build_conversation_turns
      SET trace_id = ${traceId}, session_id = ${sessionId}
      WHERE project_id = ${this.projectId} AND id = ${turnId}
        AND owner_fence = ${ownerFence}
        AND EXISTS (
          SELECT 1 FROM build_conversations c
          WHERE c.project_id = ${this.projectId}
            AND c.id = build_conversation_turns.conversation_id
            AND c.owner_fence = ${ownerFence}
        )
        AND status IN ('started','running')
      RETURNING *
    `)
    if (!result.rows[0]) throw new ConversationOwnershipLostError(turnId)
    return toTurn(result.rows[0])
  }

  async setSnapshot(
    turnId: string,
    snapshot: Record<string, unknown>,
    ownerFence: number,
    options: { preserveAgentRevision?: boolean } = {}
  ): Promise<ConversationTurn> {
    const preserveAgentRevision = options.preserveAgentRevision !== false
    const result = await this.database.execute<Record<string, unknown>>(sql`
      UPDATE build_conversation_turns
      SET snapshot_json =
        (snapshot_json || ${json(snapshot)}::jsonb)
        ${
          preserveAgentRevision
            ? sql`|| CASE WHEN snapshot_json ? 'agentRevision'
            THEN jsonb_build_object('agentRevision', snapshot_json->'agentRevision')
            ELSE '{}'::jsonb
          END`
            : sql``
        }
      WHERE project_id = ${this.projectId} AND id = ${turnId}
        AND owner_fence = ${ownerFence}
        AND EXISTS (
          SELECT 1 FROM build_conversations c
          WHERE c.project_id = ${this.projectId}
            AND c.id = build_conversation_turns.conversation_id
            AND c.owner_fence = ${ownerFence}
        )
        AND status IN ('started','running')
      RETURNING *
    `)
    if (!result.rows[0]) throw new ConversationOwnershipLostError(turnId)
    return toTurn(result.rows[0])
  }

  async recordToolCallStart(input: {
    conversationId: string
    turnId: string
    toolCallId: string
    actionId: string
    args: Record<string, unknown>
    ownerFence?: number
  }): Promise<ConversationToolCall> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      INSERT INTO build_conversation_tool_calls
        (id, project_id, conversation_id, turn_id, tool_call_id, action_id,
         status, input_json)
      SELECT
        ${this.makeId()}, ${this.projectId}, ${input.conversationId}, ${input.turnId},
        ${input.toolCallId}, ${input.actionId}, 'executing', ${json(input.args)}::jsonb
      WHERE EXISTS (
        SELECT 1 FROM build_conversations c
        JOIN build_conversation_turns t
          ON t.project_id = c.project_id AND t.conversation_id = c.id
        WHERE c.project_id = ${this.projectId}
          AND c.id = ${input.conversationId}
          AND t.id = ${input.turnId}
          AND t.owner_fence = c.owner_fence
          AND t.status IN ('started','running','awaiting_client')
          ${input.ownerFence === undefined ? sql`` : sql`AND c.owner_fence = ${input.ownerFence}`}
      )
      ON CONFLICT (project_id, turn_id, tool_call_id)
      DO UPDATE SET input_json = EXCLUDED.input_json
      RETURNING *
    `)
    if (!result.rows[0]) {
      if (input.ownerFence !== undefined)
        throw new ConversationOwnershipLostError(input.turnId)
      throw new Error("Unable to persist tool call.")
    }
    return toToolCall(result.rows[0])
  }

  async recordToolCallFinish(input: {
    conversationId: string
    turnId: string
    toolCallId: string
    status: ConversationToolCall["status"]
    output?: unknown
    error?: Record<string, unknown> | null
    continuation?: Record<string, unknown> | null
    ownerFence?: number
  }): Promise<ConversationToolCall | null> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      UPDATE build_conversation_tool_calls
      SET status = ${input.status},
          output_json = ${input.output === undefined ? null : json(input.output)}::jsonb,
          error_json = ${input.error ? json(input.error) : null}::jsonb,
          continuation_json = ${input.continuation ? json(input.continuation) : null}::jsonb,
          completed_at = now()
      WHERE project_id = ${this.projectId} AND conversation_id = ${input.conversationId}
        AND turn_id = ${input.turnId} AND tool_call_id = ${input.toolCallId}
        AND status IN ('planned','executing','awaiting_client')
        AND EXISTS (
          SELECT 1 FROM build_conversations c
          JOIN build_conversation_turns t
            ON t.project_id = c.project_id AND t.conversation_id = c.id
          WHERE c.project_id = ${this.projectId}
            AND c.id = ${input.conversationId}
            AND t.id = ${input.turnId}
            AND t.owner_fence = c.owner_fence
            ${input.ownerFence === undefined ? sql`` : sql`AND c.owner_fence = ${input.ownerFence}`}
        )
      RETURNING *
    `)
    if (!result.rows[0] && input.ownerFence !== undefined)
      throw new ConversationOwnershipLostError(input.turnId)
    return result.rows[0] ? toToolCall(result.rows[0]) : null
  }

  /**
   * Atomically consume one client continuation. A continuation is a durable
   * one-shot capability: once claimed, a second delivery cannot execute the
   * action again even when it uses a different request key.
   */
  async claimContinuation(input: {
    conversationId: string
    turnId: string
    ownerFence: number
    actionId: string
    widgetId?: string
    continuationId?: string
    allowApproval?: boolean
  }): Promise<{
    call: ConversationToolCall
    sourceSnapshot: Record<string, unknown>
  } | null> {
    return this.database.transaction(async (tx) => {
      const pending = await tx.execute<Record<string, unknown>>(sql`
        SELECT tc.*, t.snapshot_json AS source_snapshot_json
        FROM build_conversation_tool_calls tc
        JOIN build_conversation_turns t
          ON t.project_id = tc.project_id AND t.id = tc.turn_id
        JOIN build_conversations c
          ON c.project_id = tc.project_id AND c.id = tc.conversation_id
        WHERE tc.project_id = ${this.projectId}
          AND tc.conversation_id = ${input.conversationId}
          AND tc.status = 'awaiting_client'
          AND t.conversation_id = tc.conversation_id
          AND c.owner_type = 'ai'
          AND c.owner_fence = ${input.ownerFence}
          AND (
            ${
              input.continuationId
                ? sql`tc.continuation_json->>'continuationId' = ${input.continuationId}`
                : sql`FALSE`
            }
          )
          AND (
            ${
              input.actionId === "__wait__"
                ? sql`tc.continuation_json->>'type' = 'wait'
                    AND (
                      tc.continuation_json->>'resumeAt' IS NULL
                      OR (tc.continuation_json->>'resumeAt')::timestamptz <= now()
                    )`
                : sql`(
                      tc.continuation_json->>'actionId' = ${input.actionId}
                      AND NOT (
                        tc.continuation_json->>'type' = 'form'
                        AND tc.continuation_json->>'submitActionId' IS NOT NULL
                      )
                    )
                    OR (
                      tc.continuation_json->>'type' = 'form'
                      AND tc.continuation_json->>'submitActionId' = ${input.actionId}
                    )
                    OR (
                      tc.continuation_json->>'type' = 'widget'
                      AND tc.continuation_json->>'widgetId' = ${input.widgetId ?? null}
                      AND EXISTS (
                        SELECT 1
                        FROM build_agent_catalog_snapshots cas
                        JOIN build_agent_catalog_widgets caw
                          ON caw.project_id = cas.project_id
                         AND caw.catalog_id = cas.id
                        JOIN build_widget_revisions wr
                          ON wr.project_id = caw.project_id
                         AND wr.widget_id = caw.widget_id
                         AND wr.revision = caw.revision
                        CROSS JOIN LATERAL jsonb_array_elements(
                          CASE
                            WHEN wr.definition_json->>'code' IS NOT NULL
                              AND jsonb_typeof(wr.definition_json->'functions') = 'array'
                            THEN wr.definition_json->'functions'
                            WHEN wr.definition_json->>'code' IS NULL
                              AND jsonb_typeof(wr.definition_json->'components') = 'array'
                            THEN wr.definition_json->'components'
                            ELSE '[]'::jsonb
                          END
                        ) AS component
                        WHERE cas.project_id = ${this.projectId}
                          AND cas.agent_id = c.agent_id
                          AND cas.agent_revision = CASE
                            WHEN t.snapshot_json->>'agentRevision' ~ '^[0-9]+$'
                            THEN (t.snapshot_json->>'agentRevision')::integer
                            ELSE -1
                          END
                          AND caw.widget_id = tc.continuation_json->>'widgetId'
                          AND (
                            (wr.definition_json->>'code' IS NOT NULL
                              AND component->>'actionId' = ${input.actionId})
                            OR (wr.definition_json->>'code' IS NULL
                              AND component->>'type' IN ('button', 'form', 'card')
                              AND (component->>'actionId' = ${input.actionId}
                                OR component->>'submitActionId' = ${input.actionId}))
                          )
                      )
                    )`
            }
          )
          ${
            input.widgetId
              ? sql`AND tc.continuation_json->>'widgetId' = ${input.widgetId}`
              : sql``
          }
          ${input.allowApproval ? sql`` : sql`AND tc.continuation_json->>'type' <> 'approval_required'`}
        ORDER BY tc.created_at DESC, tc.id DESC
        LIMIT 1
        FOR UPDATE
      `)
      if (!pending.rows[0]) return null
      const claimed = await tx.execute<Record<string, unknown>>(sql`
        UPDATE build_conversation_tool_calls
        SET status = 'executing', turn_id = ${input.turnId}, completed_at = NULL
        WHERE project_id = ${this.projectId}
          AND id = ${String(pending.rows[0].id)}
          AND status = 'awaiting_client'
          AND EXISTS (
            SELECT 1 FROM build_conversation_turns t
            WHERE t.project_id = ${this.projectId}
              AND t.id = ${input.turnId}
              AND t.conversation_id = ${input.conversationId}
              AND t.owner_fence = ${input.ownerFence}
              AND t.status IN ('started','running')
          )
        RETURNING *
      `)
      if (!claimed.rows[0]) return null
      return {
        call: toToolCall(claimed.rows[0]),
        sourceSnapshot: asObject(pending.rows[0].source_snapshot_json),
      }
    })
  }

  async finishTurn(input: {
    turnId: string
    ownerFence: number
    status:
      | Exclude<ConversationTurnStatus, "started" | "running" | "uncertain">
      | "uncertain"
    outputMessageId?: string | null
    usage?: Record<string, unknown>
    error?: Record<string, unknown> | null
  }): Promise<ConversationTurn> {
    return this.database.transaction(async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(sql`
        UPDATE build_conversation_turns
        SET status = ${input.status}, output_message_id = ${input.outputMessageId ?? null},
            usage_json = ${json(input.usage ?? {})}::jsonb,
            error_json = ${input.error ? json(input.error) : null}::jsonb,
            completed_at = now(), lock_expires_at = NULL
        WHERE project_id = ${this.projectId} AND id = ${input.turnId}
          AND owner_fence = ${input.ownerFence}
          AND EXISTS (
            SELECT 1 FROM build_conversations c
            WHERE c.project_id = ${this.projectId}
              AND c.id = build_conversation_turns.conversation_id
              AND c.owner_fence = ${input.ownerFence}
          )
          AND status IN ('started','running','awaiting_client')
        RETURNING *
      `)
      if (!result.rows[0]) {
        const current = await tx.execute<Record<string, unknown>>(sql`
          SELECT * FROM build_conversation_turns
          WHERE project_id = ${this.projectId} AND id = ${input.turnId}
          LIMIT 1
        `)
        if (current.rows[0])
          throw new ConversationOwnershipLostError(input.turnId)
        throw new Error("Conversation turn was not found.")
      }
      return toTurn(result.rows[0])
    })
  }

  async markUncertain(
    turnId: string,
    error: Record<string, unknown>,
    ownerFence?: number
  ) {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      UPDATE build_conversation_turns
      SET status = 'uncertain', error_json = ${json(error)}::jsonb,
          completed_at = now(), lock_expires_at = NULL
      WHERE project_id = ${this.projectId} AND id = ${turnId}
        ${ownerFence === undefined ? sql`` : sql`AND owner_fence = ${ownerFence}`}
        ${
          ownerFence === undefined
            ? sql``
            : sql`
          AND EXISTS (
            SELECT 1 FROM build_conversations c
            WHERE c.project_id = ${this.projectId}
              AND c.id = build_conversation_turns.conversation_id
              AND c.owner_fence = ${ownerFence}
          )
        `
        }
        AND status IN ('started','running','awaiting_client')
      RETURNING *
    `)
    return result.rows[0] ? toTurn(result.rows[0]) : null
  }

  async setVariables(
    conversationId: string,
    variables: Record<string, unknown>,
    ownerFence?: number
  ): Promise<Conversation> {
    return this.database.transaction(async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(sql`
        UPDATE build_conversations
        SET variables_json = ${json(variables)}::jsonb, updated_at = now()
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
          ${ownerFence === undefined ? sql`` : sql`AND owner_fence = ${ownerFence}`}
        RETURNING *
      `)
      if (!result.rows[0]) {
        if (ownerFence !== undefined)
          throw new ConversationOwnershipLostError(conversationId)
        throw new ConversationNotFoundError(conversationId)
      }
      return toConversation(result.rows[0])
    })
  }

  async claim(
    conversationId: string,
    owner: { type: ConversationOwnerType; id?: string | null; reason: string },
    options: {
      expectedOwnerFence?: number
      expectedOwnerType?: ConversationOwnerType
      /** Bind a runtime-owned handoff to the completed turn for crash repair. */
      handoffTurnId?: string
    } = {}
  ): Promise<Conversation> {
    if (owner.type === "human" && !owner.id)
      throw new Error("A human owner requires an actor id.")
    if (!owner.reason.trim())
      throw new Error("An ownership reason is required.")
    return this.database.transaction(async (tx) => {
      const currentResult = await tx.execute<Record<string, unknown>>(sql`
        SELECT * FROM build_conversations
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
        LIMIT 1 FOR UPDATE
      `)
      if (!currentResult.rows[0])
        throw new ConversationNotFoundError(conversationId)
      const current = toConversation(currentResult.rows[0])
      if (
        options.expectedOwnerFence !== undefined &&
        current.ownerFence !== options.expectedOwnerFence
      )
        throw new ConversationOwnershipLostError(conversationId)
      if (
        options.expectedOwnerType !== undefined &&
        current.ownerType !== options.expectedOwnerType
      )
        throw new ConversationOwnershipLostError(conversationId)
      const nextFence = current.ownerFence + 1
      const nextStatus = owner.type === "human" ? "handed_off" : "active"
      if (options.handoffTurnId) {
        if (owner.type !== "human")
          throw new Error("A handoff turn requires a human owner.")
        const handoffTurn = await tx.execute<Record<string, unknown>>(sql`
          SELECT id, conversation_id, owner_fence, status
          FROM build_conversation_turns
          WHERE project_id = ${this.projectId} AND id = ${options.handoffTurnId}
          LIMIT 1 FOR UPDATE
        `)
        const row = handoffTurn.rows[0]
        if (
          !row ||
          String(row.conversation_id) !== conversationId ||
          Number(row.owner_fence) !== current.ownerFence ||
          String(row.status) !== "awaiting_client"
        )
          throw new ConversationOwnershipLostError(options.handoffTurnId)
        const marked = await tx.execute<Record<string, unknown>>(sql`
          UPDATE build_conversation_turns
          SET snapshot_json = snapshot_json || ${json({
            handoff: { ownerType: "human", ownerFence: nextFence },
          })}::jsonb
          WHERE project_id = ${this.projectId} AND id = ${options.handoffTurnId}
          RETURNING id
        `)
        if (!marked.rows[0])
          throw new ConversationOwnershipLostError(options.handoffTurnId)
      }
      const updatedResult = await tx.execute<Record<string, unknown>>(sql`
        UPDATE build_conversations
        SET owner_type = ${owner.type}, owner_id = ${owner.id ?? null},
            owner_fence = ${nextFence}, status = ${nextStatus}, updated_at = now()
        WHERE project_id = ${this.projectId} AND id = ${conversationId}
        RETURNING *
      `)
      if (owner.type === "human") {
        await ensureEscalationTicket(tx, this.projectId, conversationId, {
          actorId: this.context.actorId,
          teamId: owner.id,
          reopen: current.ownerType !== "human",
        })
        // A takeover fences every in-flight AI turn. Its provider outcome is
        // no longer safe to classify as a clean cancellation: a tool may have
        // reached its destination while the worker was being fenced out.
        await tx.execute(sql`
          UPDATE build_conversation_turns
          SET status = 'uncertain',
              error_json = ${json({
                kind: "CONVERSATION_HUMAN_OWNED",
                message:
                  "The conversation was handed to a human while the AI turn was running.",
              })}::jsonb,
              completed_at = now(), lock_expires_at = NULL
          WHERE project_id = ${this.projectId} AND conversation_id = ${conversationId}
            AND status IN ('started','running')
            AND owner_fence < ${nextFence}
        `)
      }
      await tx.execute(sql`
        INSERT INTO build_conversation_ownership_events
          (id, project_id, conversation_id, from_owner_type, from_owner_id,
           to_owner_type, to_owner_id, fence, reason)
        VALUES
          (${this.makeId()}, ${this.projectId}, ${conversationId},
           ${current.ownerType}, ${current.ownerId}, ${owner.type}, ${owner.id ?? null},
           ${nextFence}, ${owner.reason})
      `)
      if (owner.type === "human" && current.ownerType !== "human") {
        const contactId =
          typeof current.metadata.contactId === "string"
            ? current.metadata.contactId
            : null
        await tx.execute(sql`
          INSERT INTO build_operation_events
            (id, project_id, event_type, conversation_id, contact_id, channel, payload_json)
          VALUES
            (${randomUUID()}, ${this.projectId}, 'handoff', ${conversationId},
             ${contactId}, ${current.channel}, ${json({
               fromOwnerType: current.ownerType,
               fromOwnerId: current.ownerId,
               toOwnerType: owner.type,
               toOwnerId: owner.id ?? null,
               ownerFence: nextFence,
               reason: owner.reason,
             })}::jsonb)
        `)
      }
      if (!updatedResult.rows[0])
        throw new Error("Unable to change conversation owner.")
      return toConversation(updatedResult.rows[0])
    })
  }

  async releaseToAi(conversationId: string, reason = "Human handoff resolved") {
    return this.claim(conversationId, { type: "ai", id: null, reason })
  }

  async getTurn(turnId: string): Promise<ConversationTurn | null> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversation_turns
      WHERE project_id = ${this.projectId} AND id = ${turnId}
      LIMIT 1
    `)
    return result.rows[0] ? toTurn(result.rows[0]) : null
  }

  async getMessage(messageId: string): Promise<ConversationMessage | null> {
    const result = await this.database.execute<Record<string, unknown>>(sql`
      SELECT * FROM build_conversation_messages
      WHERE project_id = ${this.projectId} AND id = ${messageId}
      LIMIT 1
    `)
    return result.rows[0] ? toMessage(result.rows[0]) : null
  }
}

export function createConversationService(
  context: ConversationContext,
  options?: ConversationServiceOptions
) {
  return new ConversationService(context, options)
}
