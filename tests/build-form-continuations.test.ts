import { afterEach, describe, expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { sql } from "drizzle-orm"

import { createAgent, getAgent, updateAgent } from "@/src/server/build/agents"
import { saveAction, saveWidget } from "@/src/server/build/definitions"
import type { ActionRecord } from "@/src/lib/build/contracts"
import {
  closeTracerDatabase,
  createTracerDatabase,
  type TracerDatabase,
} from "@/src/server/tracer/db"
import {
  ConversationService,
  type ConversationContext,
} from "@/src/server/build/conversations"
import { runAgentTurn } from "@/src/server/build/runtime"
import {
  createIsolatedPostgres,
  migrateIsolatedPostgres,
  seedTestWorkspace,
  type IsolatedPostgres,
} from "@/tests/helpers/postgres"

const databaseEnabled = Boolean(process.env.DATOOL_TEST_DATABASE_URL)
const resources: Array<{ database: TracerDatabase; target: IsolatedPostgres }> =
  []

afterEach(async () => {
  for (const { database, target } of resources.splice(0)) {
    await closeTracerDatabase(database)
    await target.close()
  }
})

async function makeContext() {
  const target = await createIsolatedPostgres()
  await migrateIsolatedPostgres(target)
  await seedTestWorkspace(target)
  const database = createTracerDatabase(target.databaseUrl, {
    projectId: target.projectId,
    schema: target.schema,
  })
  resources.push({ database, target })
  const context: ConversationContext = {
    database,
    projectId: target.projectId,
  }
  await createAgent(context, {
    id: "agent-a",
    name: "Forms agent",
    slug: "forms-agent",
  })
  return { context, service: new ConversationService(context) }
}

function httpAction(
  context: ConversationContext,
  id: string,
  name: string
): ActionRecord {
  return {
    id,
    projectId: context.projectId,
    agentId: "agent-a",
    slug: id,
    revision: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    definition: {
      id,
      type: "http",
      name,
      description: "",
      enabled: true,
      channels: ["web"],
      procedureOnly: false,
      inputSchema: {},
      method: "POST",
      url: "https://example.test/orders",
      headers: {},
      bodyTemplate: "{{input}}",
      responseSchema: {},
      timeoutMs: 1_000,
    },
  }
}

const modelTool = (actionId: string, toolCallId: string) =>
  (async (options: {
    tools: Record<
      string,
      {
        execute: (
          input: Record<string, unknown>,
          options: { toolCallId: string }
        ) => Promise<unknown>
      }
    >
  }) => {
    await options.tools[actionId].execute({}, { toolCallId })
    return {
      text: "The form is ready.",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    }
  }) as never

async function applyCatalog(context: ConversationContext) {
  const current = await getAgent(context, "agent-a")
  await updateAgent(context, "agent-a", {
    expectedRevision: current.currentRevision,
    apply: true,
  })
}

const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error
    ? (error as { code?: unknown }).code
    : undefined

describe("Build customer form continuations", () => {
  const dbTest = (name: string, fn: () => Promise<void>) => {
    if (databaseEnabled) test(name, fn)
  }

  dbTest(
    "executes the persisted form submit target once and rejects a forged target",
    async () => {
      const { context, service } = await makeContext()
      const target = await saveAction(context, "agent-a", {
        id: "submit-order",
        definition: httpAction(context, "submit-order", "Submit order")
          .definition,
      })
      const form = await saveAction(context, "agent-a", {
        id: "order-form",
        definition: {
          id: "order-form",
          type: "form",
          name: "Order form",
          channels: ["web"],
          fields: [
            {
              name: "orderId",
              label: "Order ID",
              type: "text",
              required: true,
            },
          ],
          submitActionId: target.id,
        },
      })
      await applyCatalog(context)

      const pending = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          externalConversationId: "web:form-target",
          requestKey: "web:form-target-1",
          message: "Open the order form",
          metadata: {},
        },
        {
          conversationService: service,
          dependencies: {
            generateText: modelTool(form.id, "form-open-1"),
          },
        }
      )
      const continuation = pending.continuations[0]
      expect(continuation).toMatchObject({
        type: "form",
        actionId: form.id,
        submitActionId: target.id,
      })
      const continuationId = continuation?.continuationId
      expect(continuationId).toBeTruthy()

      await rejects(
        runAgentTurn(
          context,
          {
            agentId: "agent-a",
            channel: "web",
            conversationId: pending.conversation.id,
            requestKey: "web:form-target-forged",
            message: "Submit the order",
            metadata: {
              widgetInteraction: {
                actionId: "order-form",
                continuationId,
                input: { orderId: "42" },
              },
            } as never,
          },
          { conversationService: service }
        ),
        (error: unknown) => errorCode(error) === "CONTINUATION_NOT_AVAILABLE"
      )

      const executed: Array<{
        actionId: string
        input: Record<string, unknown>
      }> = []
      const resumed = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          conversationId: pending.conversation.id,
          requestKey: "web:form-target-2",
          message: "Submit the order",
          metadata: {
            widgetInteraction: {
              actionId: target.id,
              continuationId,
              input: { orderId: "42" },
            },
          } as never,
        },
        {
          conversationService: service,
          dependencies: {
            executeAction: async ({
              action,
              input,
            }: {
              action: ActionRecord["definition"]
              input: Record<string, unknown>
            }) => {
              executed.push({ actionId: action.id, input })
              return { output: { accepted: true } }
            },
          },
        }
      )

      expect(resumed.status).toBe("completed")
      expect(executed).toEqual([
        { actionId: target.id, input: { orderId: "42" } },
      ])
    }
  )

  for (const layout of ["legacy", "jsx"] as const)
    dbTest(
      `admits only pinned ${layout} widget actions for a widget continuation`,
      async () => {
        const { context, service } = await makeContext()
        const target = await saveAction(context, "agent-a", {
          id: "confirm-order",
          definition: httpAction(context, "confirm-order", "Confirm order")
            .definition,
        })
        const unlisted = await saveAction(context, "agent-a", {
          id: "unlisted-action",
          definition: httpAction(context, "unlisted-action", "Unlisted action")
            .definition,
        })
        const layoutDefinition =
          layout === "jsx"
            ? {
                code: 'export default function Widget() { return <Button onClickAction="confirm">Confirm</Button> }',
                schemaCode:
                  'import { z } from "zod"; export default z.object({})',
                functions: [{ name: "confirm", actionId: target.id }],
              }
            : {
                components: [
                  { type: "button", label: "Confirm", actionId: target.id },
                ],
              }
        const widget = await saveWidget(context, "agent-a", {
          id: "order-widget",
          definition: {
            name: "Order choices",
            ...layoutDefinition,
          },
        })
        const opener = await saveAction(context, "agent-a", {
          id: "show-order-widget",
          definition: {
            id: "show-order-widget",
            type: "widget",
            name: "Show order choices",
            channels: ["web"],
            eventName: "show_order_widget",
            widgetId: widget.id,
          },
        })
        await applyCatalog(context)

        const pending = await runAgentTurn(
          context,
          {
            agentId: "agent-a",
            channel: "web",
            externalConversationId: "web:widget-child",
            requestKey: "web:widget-child-1",
            message: "Show choices",
            metadata: {},
          },
          {
            conversationService: service,
            dependencies: {
              generateText: modelTool(opener.id, "widget-open-1"),
            },
          }
        )
        const continuationId = pending.continuations[0]?.continuationId
        expect(continuationId).toBeTruthy()

        expect(pending.message?.metadata).toMatchObject({
          continuations: [
            {
              type: "widget",
              continuationId,
              widgetDefinition: {
                name: "Order choices",
                ...layoutDefinition,
              },
            },
          ],
        })

        // A later edit cannot change the capabilities of the already-issued widget.
        await saveWidget(context, "agent-a", {
          id: widget.id,
          expectedRevision: widget.revision,
          definition: {
            name: "Changed choices",
            code: '<Button onClickAction="other">Other</Button>',
            functions: [{ name: "other", actionId: unlisted.id }],
          },
        })
        await applyCatalog(context)

        await rejects(
          runAgentTurn(
            context,
            {
              agentId: "agent-a",
              channel: "web",
              conversationId: pending.conversation.id,
              requestKey: "web:widget-child-forged",
              message: "Do something else",
              metadata: {
                widgetInteraction: {
                  actionId: unlisted.id,
                  widgetId: widget.id,
                  continuationId,
                  input: {},
                },
              } as never,
            },
            { conversationService: service }
          ),
          (error: unknown) => errorCode(error) === "CONTINUATION_NOT_AVAILABLE"
        )

        const executed: string[] = []
        const resumed = await runAgentTurn(
          context,
          {
            agentId: "agent-a",
            channel: "web",
            conversationId: pending.conversation.id,
            requestKey: "web:widget-child-2",
            message: "Confirm",
            metadata: {
              widgetInteraction: {
                actionId: target.id,
                widgetId: widget.id,
                continuationId,
                input: {},
              },
            } as never,
          },
          {
            conversationService: service,
            dependencies: {
              executeAction: async ({
                action,
              }: {
                action: ActionRecord["definition"]
              }) => {
                executed.push(action.id)
                return { output: { accepted: true } }
              },
            },
          }
        )
        expect(resumed.status).toBe("completed")
        expect(executed).toEqual([target.id])
      }
    )

  dbTest(
    "opens a lead form from a widget and stores one lead when submission is replayed",
    async () => {
      const { context, service } = await makeContext()
      const form = await saveAction(context, "agent-a", {
        id: "contact-form",
        definition: {
          id: "contact-form",
          type: "form",
          name: "Contact form",
          captureLead: true,
          channels: ["web"],
          fields: [
            {
              name: "email",
              label: "Email",
              type: "email",
              required: true,
            },
            { name: "isAgency", label: "Agency", type: "checkbox" },
            { name: "consent", label: "Contact consent", type: "checkbox", required: true },
          ],
        },
      })
      const widget = await saveWidget(context, "agent-a", {
        id: "lead-widget",
        definition: {
          name: "Contact us",
          components: [
            { type: "button", label: "Request demo", actionId: form.id },
          ],
        },
      })
      const opener = await saveAction(context, "agent-a", {
        id: "show-lead-widget",
        definition: {
          id: "show-lead-widget",
          type: "widget",
          name: "Show contact widget",
          channels: ["web"],
          widgetId: widget.id,
          eventName: "request_demo",
        },
      })
      await applyCatalog(context)

      const widgetPending = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          externalConversationId: "web:standalone-form",
          requestKey: "web:standalone-form-1",
          message: "Open the contact form",
          metadata: {},
        },
        {
          conversationService: service,
          dependencies: {
            generateText: modelTool(opener.id, "standalone-form-open-1"),
          },
        }
      )
      const pending = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          conversationId: widgetPending.conversation.id,
          requestKey: "web:standalone-form-open",
          message: "Request demo",
          metadata: {
            widgetInteraction: {
              actionId: form.id,
              widgetId: widget.id,
              continuationId: widgetPending.continuations[0]?.continuationId,
              input: {},
            },
          } as never,
        },
        { conversationService: service }
      )
      const continuationId = pending.continuations[0]?.continuationId
      expect(continuationId).toBeTruthy()

      const resumed = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          conversationId: pending.conversation.id,
          requestKey: "web:standalone-form-2",
          message: "Submit the contact form",
          metadata: {
            widgetInteraction: {
              actionId: form.id,
              continuationId,
              input: { email: "customer@example.test", isAgency: false, consent: true },
            },
          } as never,
        },
        { conversationService: service }
      )

      expect(resumed.status).toBe("completed")
      const replay = await runAgentTurn(
        context,
        {
          agentId: "agent-a",
          channel: "web",
          conversationId: pending.conversation.id,
          requestKey: "web:standalone-form-2",
          message: "Submit the contact form",
          metadata: {
            widgetInteraction: {
              actionId: form.id,
              continuationId,
              input: { email: "customer@example.test", isAgency: false, consent: true },
            },
          } as never,
        },
        { conversationService: service }
      )
      expect(replay.status).toBe("replayed")
      expect(resumed.message?.metadata.completedContinuationId).toBe(
        continuationId
      )
      const rows = await context.database.execute<{
        field_key: string
        value_json: unknown
        source: string
      }>(sql`
      SELECT field_key, value_json, source
      FROM build_collected_data
      WHERE project_id = ${context.projectId}
        AND conversation_id = ${pending.conversation.id}
    `)
      expect(rows.rows.sort((a, b) => a.field_key.localeCompare(b.field_key))).toEqual([
        { field_key: "consent", value_json: true, source: "form" },
        {
          field_key: "email",
          value_json: "customer@example.test",
          source: "form",
        },
        { field_key: "isAgency", value_json: false, source: "form" },
      ])
      const leads = await context.database.execute<{ data_json: unknown }>(sql`
      SELECT data_json FROM build_leads
      WHERE project_id = ${context.projectId}
        AND conversation_id = ${pending.conversation.id}
    `)
      expect(leads.rows).toEqual([
        { data_json: { email: "customer@example.test", isAgency: false, consent: true } },
      ])
    }
  )
})
