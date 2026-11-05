/** Local-only, additive UI fixtures. Usage: bun scripts/seed-ui-demo.ts <existing-project-slug> */
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { Pool } from "pg"
import { sql } from "drizzle-orm"
import { createAgent } from "../src/server/build/agents"
import { ConversationService } from "../src/server/build/conversations"
import { createContact } from "../src/server/build/operations/contacts"
import { createTicket } from "../src/server/build/operations/inbox"
import {
  createTracerDatabase,
  closeTracerDatabase,
} from "../src/server/tracer/db"
import { TracerService } from "../src/server/tracer/service"
import { runTracerEffect as run } from "../src/server/tracer/effect"
import { createDashboardService } from "../src/server/tracer/dashboards"
import { createProjectHomeService } from "../src/server/tracer/project-home"
import {
  agentDirectoryDimensions,
  performanceMeasures,
} from "../src/lib/tracer/performance-table"

const sourceSlug = process.argv[2]
assert(sourceSlug, "Pass a local project slug to select its organization")
const url = new URL(process.env.DATABASE_URL ?? "")
assert(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Demo seeding requires local PostgreSQL"
)
const pool = new Pool({ connectionString: url.toString() })
const fixture = "ui-demo-v1"
const slug = "ui-demo"
const metadata = { synthetic: true, fixture }
const now = Date.now()
const iso = (value: number) => new Date(value).toISOString()

try {
  const source = await pool.query<{ organization_id: string }>(
    "select organization_id from project where slug = $1",
    [sourceSlug]
  )
  assert.equal(
    source.rows.length,
    1,
    "Expected one existing local source project"
  )
  const organizationId = source.rows[0].organization_id
  const projectId = `proj_ui_demo_${createHash("sha256").update(organizationId).digest("hex").slice(0, 10)}`
  const existing = await pool.query<{ id: string }>(
    "select id from project where organization_id = $1 and slug = $2",
    [organizationId, slug]
  )
  assert(
    !existing.rows.length || existing.rows[0].id === projectId,
    "The UI demo slug belongs to another project"
  )
  await pool.query(
    "insert into project (id, organization_id, name, slug) values ($1, $2, $3, $4) on conflict (id) do nothing",
    [projectId, organizationId, "UI demo (sample data)", slug]
  )
  const database = createTracerDatabase(url.toString(), { projectId })
  const context = { database, projectId, organizationId }
  const tracer = new TracerService(database)
  const ledger = new ConversationService(context)
  const id = (value: string) => `${projectId}-${value}`
  const ensureSession = async (
    sessionId: string,
    name: string,
    attributes = metadata
  ) => {
    const existingSession = await database.execute(
      sql`select id from sessions where project_id = ${projectId} and id = ${sessionId}`
    )
    if (!existingSession.rows.length)
      await run(tracer.createSession({ id: sessionId, name, attributes }))
  }
  try {
    const agents = [
      { slug: "store", name: "Store assistant", color: "orange" },
      { slug: "support", name: "Customer support", color: "violet" },
      { slug: "guide", name: "Product guide", color: "blue" },
    ] as const
    for (const agent of agents) {
      const found = await database.execute(
        sql`select id from build_agents where project_id = ${projectId} and id = ${id(agent.slug)}`
      )
      if (!found.rows.length)
        await createAgent(context, {
          id: id(agent.slug),
          slug: agent.slug,
          name: agent.name,
          description:
            "Synthetic local UI demo. No external channel is connected.",
          configuration: {
            appearance: {
              displayName: agent.name,
              avatarColor: agent.color,
              welcomeMessage: "Hi! How can I help you today?",
            },
            metadata,
          },
        })
    }

    const conversations = [
      [
        "Casey Morgan",
        "Where is my order?",
        "Your order is on its way and should arrive tomorrow.",
        "web",
        "open",
      ],
      [
        "Jordan Lee",
        "Can I exchange this for a medium?",
        "Yes. Choose Exchange in your order details and select medium.",
        "whatsapp",
        "solved",
      ],
      [
        "Sam Rivera",
        "My payment was charged twice",
        "I have passed this to our billing team to review both charges.",
        "web",
        "pending",
      ],
      [
        "Alex Chen",
        "Which backpack fits a 16-inch laptop?",
        "The Everyday Pack has a padded sleeve for laptops up to 16 inches.",
        "web",
        "solved",
      ],
      [
        "Taylor Reed",
        "Update the delivery address",
        "A teammate will check whether the warehouse can still update your address.",
        "whatsapp",
        "open",
      ],
      [
        "Jamie Park",
        "Do you ship internationally?",
        "We ship to more than 30 countries. Delivery options appear at checkout.",
        "web",
        "solved",
      ],
      ["Robin Ellis", "Is the blue jacket coming back?", "", "web", "open"],
      ["Avery Brooks", "I need help choosing a gift", "", "whatsapp", "open"],
    ] as const
    const conversationIds: string[] = []
    for (const [
      index,
      [name, question, answer, channel, status],
    ] of conversations.entries()) {
      const contact = await createContact(context, {
        externalId: id(`contact-${index}`),
        displayName: name,
        email: `customer${index + 1}@example.com`,
        metadata,
      })
      const conversation = await ledger.getOrCreate({
        agentId: id(index % 2 ? "support" : "store"),
        channel,
        externalConversationId: id(`conversation-${index}`),
        metadata: { ...metadata, contactId: contact.id },
      })
      conversationIds.push(conversation.id)
      const messages = await ledger.listMessages(conversation.id)
      if (!messages.items.length) {
        await ledger.appendMessage(conversation.id, {
          role: "user",
          content: question,
          status: "completed",
          metadata,
        })
        if (answer)
          await ledger.appendMessage(conversation.id, {
            role: "assistant",
            content: answer,
            status: "completed",
            metadata,
          })
      }
      const existingTicket = await database.execute(
        sql`select id from build_inbox_tickets where project_id = ${projectId} and conversation_id = ${conversation.id}`
      )
      if (!existingTicket.rows.length)
        await createTicket(context, {
          conversationId: conversation.id,
          contactId: contact.id,
          channel,
          subject: question,
          status,
          priority: index === 2 ? "high" : "normal",
          tags: ["sample-data"],
        })
      if ((index === 2 || index === 4) && conversation.ownerType !== "human") {
        await ledger.claim(conversation.id, {
          type: "human",
          id: id("sample-support-owner"),
          reason: "Synthetic local demo handoff awaiting takeover",
        })
      } else if (status === "solved" && conversation.status !== "closed") {
        await database.execute(
          sql`update build_conversations set status = 'closed' where project_id = ${projectId} and id = ${conversation.id}`
        )
      }
      if (index < 6) await ensureSession(conversation.id, question)
    }

    for (let index = 0; index < 4; index++)
      await ensureSession(
        id(`sdk-session-${index}`),
        [
          "Personalized recommendations",
          "Checkout assistance",
          "Product comparison",
          "Order follow-up",
        ][index]
      )
    for (let index = 0; index < 36; index++) {
      const traceId = id(`trace-${index}`)
      const found = await database.execute(
        sql`select id from traces where project_id = ${projectId} and id = ${traceId}`
      )
      if (found.rows.length) continue
      const tracedOnly = index % 3 === 2
      const agent = agents[index % 2]
      const started = now - (index * 3 + 1) * 3_600_000
      const duration = 500 + (index % 7) * 230
      const question = conversations[index % 6][1]
      const answer = conversations[index % 6][2]
      const errored = index % 13 === 12
      await run(
        tracer.createTrace({
          id: traceId,
          sessionId: tracedOnly
            ? id(`sdk-session-${index % 4}`)
            : conversationIds[index % 6],
          name: question,
          operation: tracedOnly
            ? "recommendation.generate"
            : "build.agent.turn",
          group: {
            type: "agent",
            name: tracedOnly ? "Recommendation engine" : agent.name,
            version: `v${(index % 2) + 1}`,
          },
          status: errored ? "errored" : "completed",
          startedAt: iso(started),
          endedAt: iso(started + duration),
          input: { messages: [{ role: "user", content: question }] },
          output: errored
            ? { error: "Synthetic upstream timeout" }
            : { role: "assistant", content: answer },
          attributes: {
            ...metadata,
            ...(!tracedOnly ? { "build.agent.id": id(agent.slug) } : {}),
            "cost.usd": 0.002 + (index % 4) * 0.001,
          },
          spans: [
            {
              id: `${traceId}-lookup`,
              name: "Look up store information",
              kind: "tool",
              status: "completed",
              startedAt: iso(started),
              endedAt: iso(started + 120),
              input: { query: question },
              output: { found: true },
              attributes: metadata,
            },
            {
              id: `${traceId}-reply`,
              name: "Generate response",
              kind: "llm",
              status: errored ? "errored" : "completed",
              startedAt: iso(started + 130),
              endedAt: iso(started + duration),
              input: [{ role: "user", content: question }],
              output: answer,
              attributes: {
                ...metadata,
                "gen_ai.request.model": "openai/gpt-4.1-mini",
                "usage.input_tokens": 320 + index * 4,
                "usage.output_tokens": 80 + index,
                "cost.usd": 0.002 + (index % 4) * 0.001,
              },
            },
          ],
        })
      )
    }

    const dashboards = createDashboardService(database)
    const catalog = await run(dashboards.list())
    const dashboardName = "UI demo overview"
    const existingDashboard = catalog.find(
      (dashboard) => dashboard.name === dashboardName
    )
    const query = (measures: string[], dimensions: string[] = []) => ({
      measures,
      dimensions,
      timeDimensions: [
        {
          dimension: "traces.startedAt",
          dateRange: [iso(now - 7 * 86_400_000), iso(now)],
        },
      ],
      limit: 20,
    })
    const dashboard = existingDashboard
      ? await run(dashboards.get(existingDashboard.id))
      : await run(
          dashboards.create({
            schemaVersion: 1,
            name: dashboardName,
            description:
              "Synthetic local UI sample activity; no model calls or external messages.",
            widgets: [
              {
                id: "volume",
                title: "Trace volume",
                type: "metric",
                width: 1,
                layout: { x: 0, y: 0, w: 6, h: 4 },
                query: query(["traces.count"]),
              },
              {
                id: "operations",
                title: "Operations",
                type: "bar",
                width: 1,
                layout: { x: 6, y: 0, w: 6, h: 4 },
                query: query(["traces.count"], ["traces.operation"]),
              },
            ],
          })
        )
    const home = createProjectHomeService(database)
    for (const widget of dashboard.widgets)
      await run(home.pin({ dashboardId: dashboard.id, widgetId: widget.id }))

    const activity = await run(
      tracer.listSessionActivity({ includeTotal: true })
    )
    const directory = await run(
      tracer.queryAgentDirectory({
        measures: performanceMeasures.map((name) => `agents.${name}`),
        dimensions: agentDirectoryDimensions,
        timeDimensions: [
          {
            dimension: "agents.startedAt",
            dateRange: [iso(now - 7 * 86_400_000), iso(now + 60_000)],
          },
        ],
        total: true,
      })
    )
    console.log(
      JSON.stringify(
        {
          url: `http://localhost:3000/p/${slug}`,
          sessions: activity.total,
          agents: directory.data.map((row) => ({
            name: row["agents.name"],
            operations: row["agents.count"],
            created: !!row["agents.managedId"],
          })),
          widgets: (await run(home.get())).widgets.length,
        },
        null,
        2
      )
    )
  } finally {
    await closeTracerDatabase(database)
  }
} finally {
  await pool.end()
}
