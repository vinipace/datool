import { afterEach, describe, expect, test } from "bun:test"
import { sql } from "drizzle-orm"
import assert from "node:assert/strict"

import {
  actionDefinitionSchema,
  agentConfigurationSchema,
  procedureDefinitionSchema,
  widgetDefinitionSchema,
} from "@/src/lib/build/contracts"
import {
  AgentConflictError,
  archiveAgent,
  cloneAgent,
  createAgent,
  getAgent,
  listAgentRevisions,
  listAgents,
  restoreAgentRevision,
  updateAgent,
} from "@/src/server/build/agents"
import { createBuildContext } from "@/src/server/build/context"
import {
  deleteAction,
  deleteProcedure,
  deleteWidget,
  DefinitionConflictError,
  getAction,
  getRuntimeAppliedDefinitions,
  getRuntimeActionDefinitions,
  listActionRevisions,
  listActions,
  listProcedureRevisions,
  listProcedures,
  listWidgetRevisions,
  listWidgets,
  saveAction,
  saveProcedure,
  saveWidget,
} from "@/src/server/build/definitions"
import {
  closeTracerFixture,
  createTracerFixture,
} from "./helpers/tracer-fixture"

const databaseEnabled = Boolean(process.env.DATOOL_TEST_DATABASE_URL)
const dbTest = (name: string, fn: () => Promise<void>) => {
  if (databaseEnabled) test(name, fn)
}

describe("Build catalog contracts", () => {
  test("normalizes the complete agent configuration and rejects unsafe values", () => {
    const configuration = agentConfigurationSchema.parse({
      instructions: "Answer from the approved knowledge base.",
      model: "openai/gpt-4.1-mini",
      channelOverrides: { telegram: { temperature: 0.4 } },
    })
    expect(configuration.appearance.displayName).toBe("Assistant")
    expect(configuration.channelAllowlist).toContain("telegram")
    expect(configuration.guardrails.maxTurns).toBe(50)
    expect(() => agentConfigurationSchema.parse({ temperature: 3 })).toThrow()
    for (const avatarUrl of [
      "javascript:alert(1)",
      "data:text/html,<svg>",
      "file:///etc/passwd",
    ]) {
      expect(() =>
        agentConfigurationSchema.parse({ appearance: { avatarUrl } })
      ).toThrow()
    }
  })

  test("keeps action, procedure, and widget definitions declarative", () => {
    const action = actionDefinitionSchema.parse({
      id: "lookup-order",
      type: "http",
      name: "Lookup order",
      method: "GET",
      url: "https://example.test/orders/{{orderId}}",
    })
    const procedure = procedureDefinitionSchema.parse({
      name: "Order lookup",
      trigger: { type: "keyword", value: "order status" },
      steps: [{ id: "lookup", kind: "action", actionId: action.id }],
    })
    const widget = widgetDefinitionSchema.parse({
      name: "Order card",
      components: [{ type: "text", text: "{{order.status}}" }],
    })
    expect(procedure.actionRefs).toEqual([])
    expect(widget.components).toHaveLength(1)
    expect("code" in widget).toBe(false)
  })
})

describe("durable project-scoped Build catalog", () => {
  let database: Awaited<ReturnType<typeof createTracerFixture>> | undefined
  let otherDatabase: Awaited<ReturnType<typeof createTracerFixture>> | undefined

  afterEach(async () => {
    if (database) await closeTracerFixture(database)
    if (otherDatabase) await closeTracerFixture(otherDatabase)
    database = undefined
    otherDatabase = undefined
  })

  dbTest(
    "persists agent revisions, applies optimistic concurrency, clones, restores, and archives",
    async () => {
      database = await createTracerFixture()
      const context = createBuildContext(database, {
        organizationId: "test-org",
      })
      const created = await createAgent(context, {
        name: "Support",
        slug: "support",
        configuration: {
          instructions: "Be concise.",
          model: "openai/gpt-4.1-mini",
        },
      })
      expect(created.currentRevision).toBe(1)
      expect((await listAgents(context)).map((agent) => agent.slug)).toEqual([
        "support",
      ])

      const draft = await updateAgent(context, created.id, {
        expectedRevision: 1,
        apply: false,
        configuration: {
          instructions: "Draft instructions.",
          model: "openai/gpt-4.1-mini",
        },
      })
      expect(draft.currentRevision).toBe(2)
      expect(draft.appliedRevision).toBe(1)
      expect(draft.appliedConfiguration?.instructions).toBe("Be concise.")
      await assert.rejects(
        updateAgent(context, created.id, { expectedRevision: 1 }),
        AgentConflictError
      )

      const applied = await updateAgent(context, created.id, {
        expectedRevision: 2,
        configuration: draft.configuration,
      })
      expect(applied.appliedRevision).toBe(3)
      const restored = await restoreAgentRevision(context, created.id, 1, 3)
      expect(restored.currentRevision).toBe(4)
      expect(restored.configuration.instructions).toBe("Be concise.")
      expect(
        (await listAgentRevisions(context, created.id)).map(
          (revision) => revision.revision
        )
      ).toEqual([4, 3, 2, 1])

      const clone = await cloneAgent(context, created.id, {
        name: "Support copy",
        slug: "support-copy",
      })
      expect(clone.id).not.toBe(created.id)
      expect(clone.configuration.instructions).toBe("Be concise.")
      const archived = await archiveAgent(context, created.id, 4)
      expect(archived.status).toBe("archived")
      expect(await listAgents(context)).toHaveLength(1)
      expect(
        (await listAgents(context, { includeArchived: true })).map(
          (agent) => agent.status
        )
      ).toEqual(["archived", "active"])
    }
  )

  dbTest(
    "persists versioned actions, procedures, and widgets under one agent",
    async () => {
      const previousEncryptionKey = process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
      process.env.DATOOL_PROVIDER_ENCRYPTION_KEY =
        previousEncryptionKey ?? "build-catalog-test-secret-0123456789abcdef"
      database = await createTracerFixture()
      try {
        const context = createBuildContext(database)
        const agent = await createAgent(context, {
          name: "Operations",
          slug: "operations",
        })
        const action = await saveAction(context, agent.id, {
          slug: "lookup-order",
          definition: {
            type: "http",
            name: "Lookup order",
            method: "GET",
            url: "https://example.test/orders",
            headers: {
              Authorization: "Bearer super-secret",
              "X-Workspace": "support",
              "X-Auth": "x-auth-secret",
            },
          },
        })
        expect(action.definition.type).toBe("http")
        if (action.definition.type === "http") {
          expect(action.definition.headers.Authorization).toBe("[redacted]")
          expect(action.definition.headers["X-Workspace"]).toBe("[redacted]")
          expect(action.definition.headers["X-Auth"]).toBe("[redacted]")
        }
        const storedAction = await database.execute<{
          definition_json: unknown
          encrypted_headers: string | null
        }>(sql`
          select definition_json, encrypted_headers
          from build_actions
          where project_id = ${context.projectId} and id = ${action.id}
        `)
        expect(storedAction.rows[0]?.encrypted_headers).toBeTruthy()
        expect(
          JSON.stringify(storedAction.rows[0]?.definition_json)
        ).not.toContain("super-secret")
        expect(
          JSON.stringify(storedAction.rows[0]?.definition_json)
        ).not.toContain("x-auth-secret")
        expect(storedAction.rows[0]?.encrypted_headers).not.toContain(
          "super-secret"
        )
        expect(storedAction.rows[0]?.encrypted_headers).not.toContain(
          "x-auth-secret"
        )
        expect(
          (await getAction(context, agent.id, action.id)).definition
        ).toEqual(action.definition)
        const appliedBeforeDefinitions = await updateAgent(context, agent.id, {
          expectedRevision: 1,
          apply: true,
        })
        expect(appliedBeforeDefinitions.appliedRevision).toBe(2)
        const runtimeAction = (
          await getRuntimeActionDefinitions(context, agent.id)
        )[0]
        expect(runtimeAction.definition.type).toBe("http")
        expect(runtimeAction.revision).toBe(1)
        if (runtimeAction.definition.type === "http")
          expect(runtimeAction.definition.headers.Authorization).toBe(
            "Bearer super-secret"
          )
        if (runtimeAction.definition.type === "http") {
          expect(runtimeAction.definition.headers["X-Workspace"]).toBe(
            "support"
          )
          expect(runtimeAction.definition.headers["X-Auth"]).toBe(
            "x-auth-secret"
          )
        }

        const actionV2 = await saveAction(context, agent.id, {
          id: action.id,
          expectedRevision: 1,
          definition: {
            type: "http",
            name: "Lookup order",
            method: "POST",
            url: "https://example.test/orders",
            headers: { Authorization: "[redacted]" },
          },
        })
        expect(actionV2.revision).toBe(2)
        expect(actionV2.definition.type).toBe("http")
        if (actionV2.definition.type === "http") {
          expect(actionV2.definition.headers.Authorization).toBe("[redacted]")
          expect(actionV2.definition.headers["X-Workspace"]).toBe("[redacted]")
          expect(actionV2.definition.headers["X-Auth"]).toBe("[redacted]")
        }
        const actionRevisions = await listActionRevisions(
          context,
          agent.id,
          action.id
        )
        expect(actionRevisions).toHaveLength(2)
        for (const revision of actionRevisions) {
          expect(revision.definition.type).toBe("http")
          if (revision.definition.type === "http") {
            expect(revision.definition.headers.Authorization).toBe("[redacted]")
            expect(revision.definition.headers["X-Workspace"]).toBe(
              "[redacted]"
            )
            expect(revision.definition.headers["X-Auth"]).toBe("[redacted]")
          }
          expect(JSON.stringify(revision)).not.toContain("super-secret")
          expect(JSON.stringify(revision)).not.toContain("x-auth-secret")
        }
        const runtimeActionAfterUpdate = (
          await getRuntimeActionDefinitions(context, agent.id)
        )[0]
        expect(runtimeActionAfterUpdate.definition.type).toBe("http")
        if (runtimeActionAfterUpdate.definition.type === "http") {
          expect(
            runtimeActionAfterUpdate.definition.headers.Authorization
          ).toBe("Bearer super-secret")
          expect(
            runtimeActionAfterUpdate.definition.headers["X-Workspace"]
          ).toBe("support")
          expect(runtimeActionAfterUpdate.definition.headers["X-Auth"]).toBe(
            "x-auth-secret"
          )
        }
        expect(runtimeActionAfterUpdate.revision).toBe(1)

        const procedure = await saveProcedure(context, agent.id, {
          slug: "lookup",
          definition: {
            name: "Lookup",
            trigger: { type: "intent", value: "lookup" },
            steps: [{ id: "lookup", kind: "action", actionId: action.id }],
            actionRefs: [action.id],
          },
        })
        const widget = await saveWidget(context, agent.id, {
          slug: "order-card",
          definition: {
            name: "Order card",
            components: [
              { type: "button", label: "Refresh", actionId: action.id },
            ],
          },
        })
        const definitionClone = await cloneAgent(context, agent.id, {
          name: "Operations copy",
          slug: "operations-copy",
        })
        const clonedActions = await listActions(context, definitionClone.id)
        const clonedProcedures = await listProcedures(
          context,
          definitionClone.id
        )
        const clonedWidgets = await listWidgets(context, definitionClone.id)
        expect(clonedActions).toHaveLength(1)
        expect(clonedProcedures).toHaveLength(1)
        expect(clonedWidgets).toHaveLength(1)
        expect(clonedActions[0]?.id).not.toBe(action.id)
        expect(clonedProcedures[0]?.definition.actionRefs).toEqual([
          clonedActions[0]?.id,
        ])
        expect(clonedWidgets[0]?.definition.components[0]).toMatchObject({
          type: "button",
          actionId: clonedActions[0]?.id,
        })
        const clonedRuntime = await getRuntimeAppliedDefinitions(
          context,
          definitionClone.id
        )
        expect(clonedRuntime.actions[0]?.revision).toBe(1)
        if (clonedRuntime.actions[0]?.definition.type === "http") {
          expect(
            clonedRuntime.actions[0].definition.headers.Authorization
          ).toBe("Bearer super-secret")
          expect(
            clonedRuntime.actions[0].definition.headers["X-Workspace"]
          ).toBe("support")
          expect(clonedRuntime.actions[0].definition.headers["X-Auth"]).toBe(
            "x-auth-secret"
          )
        }
        expect(await listActions(context, agent.id)).toHaveLength(1)
        expect(await listProcedures(context, agent.id)).toHaveLength(1)
        expect(await listWidgets(context, agent.id)).toHaveLength(1)
        expect(
          await listProcedureRevisions(context, agent.id, procedure.id)
        ).toHaveLength(1)
        expect(
          await listWidgetRevisions(context, agent.id, widget.id)
        ).toHaveLength(1)

        const appliedWithDefinitions = await updateAgent(context, agent.id, {
          expectedRevision: 2,
          apply: true,
        })
        const appliedBundle = await getRuntimeAppliedDefinitions(
          context,
          agent.id
        )
        expect(appliedBundle.agentRevision).toBe(3)
        expect(appliedBundle.actions[0]?.revision).toBe(2)
        expect(appliedBundle.procedures[0]?.revision).toBe(1)
        expect(appliedBundle.widgets[0]?.revision).toBe(1)
        expect(appliedWithDefinitions.appliedRevision).toBe(3)

        await assert.rejects(
          deleteAction(context, agent.id, action.id, 2),
          DefinitionConflictError
        )
        await deleteProcedure(context, agent.id, procedure.id, 1)
        await deleteWidget(context, agent.id, widget.id, 1)
        const republished = await updateAgent(context, agent.id, {
          expectedRevision: 3,
          apply: true,
        })
        expect(republished.appliedRevision).toBe(4)
        const currentAfterRepublish = await getRuntimeAppliedDefinitions(
          context,
          agent.id
        )
        expect(currentAfterRepublish.agentRevision).toBe(4)
        expect(currentAfterRepublish.procedures).toHaveLength(0)
        expect(currentAfterRepublish.widgets).toHaveLength(0)

        // Runtime turns may pin the catalog revision captured at admission;
        // publishing again must not change the historical bundle they use.
        const pinnedBeforeRepublish = await getRuntimeAppliedDefinitions(
          context,
          agent.id,
          appliedBundle.agentRevision
        )
        expect(pinnedBeforeRepublish.agentRevision).toBe(3)
        expect(pinnedBeforeRepublish.actions[0]?.revision).toBe(2)
        expect(pinnedBeforeRepublish.procedures).toHaveLength(1)
        expect(pinnedBeforeRepublish.widgets).toHaveLength(1)
        await assert.rejects(
          getRuntimeAppliedDefinitions(context, agent.id, 999),
          DefinitionConflictError
        )
        await deleteAction(context, agent.id, action.id, 2)
        // A current-row soft delete is safe for the live immutable snapshot,
        // while a hard delete cannot cascade through a referenced revision.
        expect(
          (await getRuntimeAppliedDefinitions(context, agent.id)).actions[0]
            ?.revision
        ).toBe(2)
        await assert.rejects(
          database.execute(
            sql`delete from build_actions where project_id = ${context.projectId} and id = ${action.id}`
          )
        )
        expect(await listActions(context, agent.id)).toHaveLength(0)
        expect(await listProcedures(context, agent.id)).toHaveLength(0)
        expect(await listWidgets(context, agent.id)).toHaveLength(0)
        // Soft deletion leaves immutable revisions available to the audit surface.
        expect(
          await listActionRevisions(context, agent.id, action.id)
        ).toHaveLength(2)
      } finally {
        if (previousEncryptionKey === undefined)
          delete process.env.DATOOL_PROVIDER_ENCRYPTION_KEY
        else process.env.DATOOL_PROVIDER_ENCRYPTION_KEY = previousEncryptionKey
      }
    }
  )

  dbTest(
    "does not expose another project's agent through the scoped context",
    async () => {
      database = await createTracerFixture()
      const context = createBuildContext(database)
      const agent = await createAgent(context, {
        name: "Private",
        slug: "private",
      })
      otherDatabase = await createTracerFixture()
      const otherProjectContext = createBuildContext(otherDatabase)
      await assert.rejects(getAgent(otherProjectContext, agent.id))
    }
  )
})
