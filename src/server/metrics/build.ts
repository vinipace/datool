import { sql, type SQL } from "drizzle-orm"
import { defineSemanticModel } from "@/src/lib/semantic/model"
import {
  semanticSqlFilters,
  type SqlFilterField,
} from "@/src/server/semantic/sql-filters"
import { aggregateSql, sqlDay } from "./aggregate-sql"
import {
  METRIC_MAX_LIMIT,
  METRIC_MAX_WINDOW_DAYS,
  metricWindow,
  quality,
} from "./common"
import {
  sourceDimension,
  sourceMeasures,
  sourceTime,
  type MeasureSpec,
} from "./source-contract"

/** Build facts use the same project-scoped, bounded SQL pipeline as other dashboards. */
function buildModel(config: {
  name: string
  table: string
  time: { key: string; column: string; title: string; definition: string }
  facts: SQL
  dimensions: [key: string, column: string, title: string][]
  measures: MeasureSpec[]
  aggregates: Record<string, SQL>
  limitations: string[]
}) {
  const timeMember = `${config.name}.${config.time.key}`
  const timestamp = sql`r.${sql.identifier(config.time.column)}`
  const fields: Record<string, SqlFilterField> = Object.fromEntries(
    config.dimensions.map(([key, column]) => [
      `${config.name}.${key}`,
      { value: sql`r.${sql.identifier(column)}`, type: "string" },
    ])
  )
  // Resolve ownership from the authoritative conversation, never event metadata.
  // The project predicate also keeps legacy, unlinked ticket IDs isolated.
  fields[`${config.name}.agentId`] = {
    value: sql`(select c.agent_id from build_conversations c
      where c.project_id = r.project_id and c.id = r.conversation_id)`,
    type: "string",
  }
  return defineSemanticModel({
    name: config.name,
    version: "v2",
    defaultMeasures: [`${config.name}.${config.measures[0][0]}`],
    maxLimit: METRIC_MAX_LIMIT,
    maxWindowDays: METRIC_MAX_WINDOW_DAYS,
    members: [
      ...sourceMeasures(
        config.name,
        config.measures,
        "Project + persisted row ID",
        config.time.definition
      ),
      sourceTime(
        config.name,
        config.time.key,
        config.time.title,
        config.time.definition
      ),
      sourceDimension(
        config.name,
        "agentId",
        "Agent",
        "Agent owning the linked conversation in this project. Unlinked facts have no agent."
      ),
      ...config.dimensions.map(([key, , title]) =>
        sourceDimension(
          config.name,
          key,
          title,
          `Recorded ${title.toLowerCase()} on the persisted fact.`
        )
      ),
    ],
    execute: async (query, context) => {
      const window = metricWindow(query, timeMember)
      const facts = sql`select ${config.facts},
        ${sqlDay(query, timeMember, sql`extract(epoch from ${timestamp}) * 1000`)} as ${sql.identifier(timeMember)}
        ${
          query.dimensions.length
            ? sql`, ${sql.join(
                query.dimensions.map(
                  (d) => sql`${fields[d].value} as ${sql.identifier(d)}`
                ),
                sql`, `
              )}`
            : sql``
        }
        from ${sql.identifier(config.table)} r
        where r.project_id = ${context.snapshot.projectId}
          and ${timestamp} >= ${window.from}::timestamptz
          and ${timestamp} < ${window.to}::timestamptz
          and ${semanticSqlFilters(query.filters, fields)}`
      const { warnings, ...page } = await aggregateSql(
        query,
        context,
        facts,
        timeMember,
        config.aggregates,
        [],
        {},
        true
      )
      return { ...page, quality: quality(config.limitations, warnings) }
    },
  })
}

export const buildEventsSemanticModel = buildModel({
  name: "buildEvents",
  table: "build_operation_events",
  time: {
    key: "occurredAt",
    column: "occurred_at",
    title: "Occurred at",
    definition: "Recorded event time, within the selected half-open window.",
  },
  facts: sql`r.event_type, r.conversation_id, r.contact_id`,
  dimensions: [
    ["eventType", "event_type", "Event type"],
    ["channel", "channel", "Channel"],
  ],
  measures: [
    [
      "count",
      "Events",
      "count",
      "events",
      "Recorded customer-operation events.",
    ],
    [
      "conversationCount",
      "Active conversations",
      "countDistinct",
      "conversations",
      "Distinct non-null conversation IDs represented by events in the window, not newly created conversations.",
    ],
    [
      "contactCount",
      "Active contacts",
      "countDistinct",
      "contacts",
      "Distinct non-null contact IDs represented by events in the window.",
    ],
    [
      "messageCount",
      "Messages",
      "count",
      "messages",
      "Recorded message_received and message_sent events.",
    ],
    [
      "handoffCount",
      "Human handoffs",
      "count",
      "handoffs",
      "Recorded AI-to-human handoff events; ticket claims are not additional handoffs.",
    ],
  ],
  aggregates: {
    count: sql`count(*)`,
    conversationCount: sql`count(distinct conversation_id)`,
    contactCount: sql`count(distinct contact_id)`,
    messageCount: sql`count(*) filter (where event_type in ('message_received', 'message_sent'))`,
    handoffCount: sql`count(*) filter (where event_type in ('handoff', 'human_handoff'))`,
  },
  limitations: [
    "Activity comes from recorded operation events. Distinct contacts and conversations across channels or periods are not additive.",
  ],
})

export const buildTicketsSemanticModel = buildModel({
  name: "buildTickets",
  table: "build_inbox_tickets",
  time: {
    key: "createdAt",
    column: "created_at",
    title: "Created at",
    definition:
      "Ticket creation time, not the date its current status was reached.",
  },
  facts: sql`r.status, extract(epoch from (r.first_response_at - r.created_at)) * 1000 as first_response_ms`,
  dimensions: [
    ["status", "status", "Status"],
    ["channel", "channel", "Channel"],
    ["priority", "priority", "Priority"],
  ],
  measures: [
    [
      "count",
      "Tickets",
      "count",
      "tickets",
      "Tickets created in the selected window.",
    ],
    [
      "resolvedCount",
      "Resolved tickets",
      "count",
      "tickets",
      "Tickets created in the selected window whose current status is solved or closed.",
    ],
    [
      "meanFirstResponseMs",
      "Average first response",
      "average",
      "ms",
      "Mean time from ticket creation to the recorded first response; unanswered tickets are excluded.",
      "Tickets with a recorded first response",
    ],
  ],
  aggregates: {
    count: sql`count(*)`,
    resolvedCount: sql`count(*) filter (where status in ('solved', 'closed'))`,
    meanFirstResponseMs: sql`avg(first_response_ms)`,
  },
  limitations: [
    "Status is the current ticket state for the creation cohort, not a historical status snapshot or resolution-date count.",
  ],
})

export const buildCsatSemanticModel = buildModel({
  name: "buildCsat",
  table: "build_csat_surveys",
  time: {
    key: "requestedAt",
    column: "requested_at",
    title: "Requested at",
    definition: "Survey request time, not response time.",
  },
  facts: sql`r.status, r.rating`,
  dimensions: [
    ["status", "status", "Status"],
    ["channel", "channel", "Channel"],
  ],
  measures: [
    [
      "responseCount",
      "CSAT responses",
      "count",
      "responses",
      "Answered surveys requested in the selected window.",
    ],
    [
      "meanRating",
      "Average CSAT (1–5)",
      "average",
      "value",
      "Mean recorded rating on the 1–5 scale; missing ratings are excluded.",
      "Surveys with a rating",
    ],
    [
      "positiveCount",
      "Positive CSAT responses",
      "count",
      "responses",
      "Surveys with a recorded rating of 4 or 5.",
    ],
    [
      "negativeCount",
      "Negative CSAT responses",
      "count",
      "responses",
      "Surveys with a recorded rating of 1 or 2.",
    ],
  ],
  aggregates: {
    responseCount: sql`count(*) filter (where status = 'answered')`,
    meanRating: sql`avg(rating)`,
    positiveCount: sql`count(*) filter (where rating >= 4)`,
    negativeCount: sql`count(*) filter (where rating <= 2)`,
  },
  limitations: [
    "Surveys belong to their request-time cohort. Unanswered surveys do not contribute a zero rating.",
  ],
})
