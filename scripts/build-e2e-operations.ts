import assert from "node:assert/strict"

type BuildOperationInput = Record<string, unknown>
type BuildOperationCall = (
  name: string,
  input?: BuildOperationInput
) => Promise<unknown>

export type BuildOperationsE2eOptions = {
  call: BuildOperationCall
  agentId: string
  connectionId: string
  conversationId: string
  ownerId: string
  passed: (message: string) => void
}

function record(value: unknown, label: string): Record<string, unknown> {
  assert(
    value && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`
  )
  return value as Record<string, unknown>
}

function records(
  value: unknown,
  label: string
): Array<Record<string, unknown>> {
  assert(Array.isArray(value), `${label} must be an array`)
  return value.map((item, index) => record(item, `${label}[${index}]`))
}

function stringValue(value: unknown, label: string): string {
  assert(typeof value === "string", `${label} must be a string`)
  return value
}

function numberValue(value: unknown, label: string): number {
  assert(typeof value === "number", `${label} must be a number`)
  return value
}

/**
 * Exercises customer operations through the caller's real HTTP operation
 * client. The harness owns server startup and authentication; this helper
 * only creates disposable project data and checks the resulting workflows.
 */
export async function runBuildOperationsE2e({
  call,
  agentId,
  connectionId,
  conversationId,
  ownerId,
  passed,
}: BuildOperationsE2eOptions) {
  const channels = records(
    await call("build_list_channels", { agentId }),
    "configured channels"
  )
  assert(
    channels.some(
      (channel) =>
        channel.id === connectionId &&
        channel.agentId === agentId &&
        channel.channel === "web"
    ),
    "The operations client must see the configured web connection."
  )

  const contact = record(
    await call("build_create_contact", {
      externalId: "build-e2e-operations-contact",
      displayName: "Operations contact",
      email: "operations-contact@example.test",
      metadata: { fixture: "build-e2e-operations" },
    }),
    "created contact"
  )
  const contactId = stringValue(contact.id, "contact id")
  const attribute = record(
    await call("build_set_contact_attribute", {
      contactId,
      key: "plan",
      value: "pro",
      source: "manual",
    }),
    "contact attribute"
  )
  assert.equal(attribute.value, "pro")
  const attributes = records(
    await call("build_list_contact_attributes", { contactId }),
    "contact attributes"
  )
  assert(
    attributes.some((item) => item.key === "plan" && item.value === "pro"),
    "The contact attribute must be readable after it is written."
  )

  const imported = record(
    await call("build_import_contacts", {
      source: "api",
      rows: [
        {
          externalId: "build-e2e-imported-contact",
          displayName: "Imported operations contact",
          email: "imported-operations-contact@example.test",
          status: "active",
          metadata: { fixture: "build-e2e-operations-import" },
        },
      ],
    }),
    "contact import"
  )
  assert.equal(imported.importedCount, 1)
  assert.equal(imported.skippedCount, 0)
  const exported = record(
    await call("build_export_contacts", { format: "json", limit: 100 }),
    "contact export"
  )
  const exportedContacts = records(exported.items, "exported contacts")
  assert(
    exportedContacts.some(
      (item) => item.externalId === "build-e2e-operations-contact"
    ),
    "Contact export must include the contact created through the API."
  )

  const lead = record(
    await call("build_upsert_lead", {
      contactId,
      conversationId,
      status: "qualified",
      score: 80,
      source: "build-e2e-operations",
      data: { fixture: true },
    }),
    "lead"
  )
  assert.equal(lead.status, "qualified")
  assert.equal(lead.score, 80)
  const leads = record(
    await call("build_list_leads", { status: "qualified", limit: 100 }),
    "qualified leads"
  )
  assert(
    records(leads.items, "qualified lead items").some(
      (item) =>
        item.id === lead.id &&
        item.contactId === contactId &&
        item.score === 80
    ),
    "The qualified lead must be returned by its status filter."
  )
  passed(
    "HTTP operations persist contacts, attributes, imports, exports and leads"
  )

  const ticketPage = record(
    await call("build_list_tickets", { channel: "web", limit: 100 }),
    "web tickets"
  )
  const ticket = records(ticketPage.items, "web ticket items").find(
    (item) => item.conversationId === conversationId
  )
  assert(ticket, "The public web admission must create an inbox ticket.")
  const ticketId = stringValue(ticket.id, "ticket id")
  const ticketVersion = numberValue(ticket.version, "ticket version")

  const team = record(
    await call("build_create_team", {
      name: "Build E2E Support",
      description: "Disposable operations workflow team",
    }),
    "support team"
  )
  const teamId = stringValue(team.id, "team id")
  await call("build_set_team_member", {
    teamId,
    userId: ownerId,
    role: "agent",
    availability: "online",
    maxConcurrent: 4,
  })
  const rule = record(
    await call("build_create_routing_rule", {
      name: "Route web visitors to Build E2E Support",
      priority: 10,
      conditions: { channel: "web" },
      teamId,
      assigneeUserId: ownerId,
    }),
    "routing rule"
  )
  const routing = record(
    await call("build_resolve_routing", {
      channel: "web",
      priority: String(ticket.priority ?? "normal"),
      tags: [],
    }),
    "resolved routing"
  )
  assert.equal(routing.ruleId, rule.id)
  assert.equal(routing.teamId, teamId)
  assert.equal(routing.assigneeUserId, ownerId)

  const assigned = record(
    await call("build_assign_ticket", {
      ticketId,
      teamId,
      assigneeUserId: ownerId,
      expectedVersion: ticketVersion,
    }),
    "assigned ticket"
  )
  const assignedVersion = numberValue(
    assigned.version,
    "assigned ticket version"
  )
  assert.equal(assigned.teamId, teamId)
  assert.equal(assigned.assigneeUserId, ownerId)

  const macro = record(
    await call("build_create_macro", {
      name: "Mark E2E priority",
      body: "Mark this customer as high priority.",
      actions: [
        { type: "set_priority", priority: "high" },
        { type: "add_tag", tag: "build-e2e-macro" },
      ],
    }),
    "ticket macro"
  )
  const applied = record(
    await call("build_apply_macro", {
      macroId: stringValue(macro.id, "macro id"),
      ticketId,
      expectedVersion: assignedVersion,
    }),
    "applied ticket macro"
  )
  assert.equal(applied.ticketId, ticketId)
  assert.equal(applied.priority, "high")
  assert(Array.isArray(applied.tags))
  assert(applied.tags.includes("build-e2e-macro"))
  assert(numberValue(applied.version, "macro ticket version") > assignedVersion)
  passed(
    "HTTP operations route an admitted web ticket and apply a versioned macro"
  )

  const note = record(
    await call("build_add_ticket_note", {
      ticketId,
      body: "Operations E2E note",
    }),
    "ticket note"
  )
  const notes = records(
    await call("build_list_ticket_notes", { ticketId }),
    "ticket notes"
  )
  assert(
    notes.some(
      (item) => item.id === note.id && item.body === "Operations E2E note"
    ),
    "The internal note must be visible in the ticket timeline."
  )

  const survey = record(
    await call("build_request_csat", {
      ticketId,
      conversationId,
      channel: "web",
    }),
    "CSAT survey"
  )
  const submitted = record(
    await call("build_submit_csat", {
      surveyId: stringValue(survey.id, "survey id"),
      rating: 5,
      comment: "Operations E2E passed",
    }),
    "submitted CSAT"
  )
  assert.equal(submitted.status, "answered")
  assert.equal(submitted.rating, 5)
  const answeredSurveys = record(
    await call("build_list_csat", { status: "answered", limit: 100 }),
    "answered CSAT surveys"
  )
  assert(
    records(answeredSurveys.items, "answered CSAT items").some(
      (item) => item.id === survey.id && item.rating === 5
    ),
    "The answered CSAT survey must be visible to operations analytics."
  )
  passed("HTTP operations persist ticket notes and an answered CSAT survey")

  const campaign = record(
    await call("build_create_campaign", {
      name: "Build E2E zero audience",
      channel: "telegram",
      template: { text: "This must never be sent." },
      audienceFilter: { contactIds: ["missing-build-e2e-contact"] },
    }),
    "zero-audience campaign"
  )
  const campaignId = stringValue(campaign.id, "campaign id")
  const snapshot = record(
    await call("build_snapshot_campaign_audience", { campaignId }),
    "campaign snapshot"
  )
  assert.equal(snapshot.audienceCount, 0)
  assert.equal(snapshot.eligibleCount, 0)
  const queued = record(
    await call("build_queue_campaign_deliveries", { campaignId }),
    "zero-audience campaign queue"
  )
  assert.equal(queued.queuedCount, 0)
  const completedCampaign = record(
    await call("build_get_campaign", { id: campaignId }),
    "completed zero-audience campaign"
  )
  assert.equal(completedCampaign.status, "completed")
  const deliveries = record(
    await call("build_list_campaign_deliveries", { campaignId, limit: 100 }),
    "zero-audience deliveries"
  )
  assert.equal(
    records(deliveries.items, "zero-audience delivery items").length,
    0
  )
  passed(
    "HTTP zero-audience Telegram campaigns reconcile completed without provider delivery"
  )

  const question = "Which disposable operations workflow was exercised?"
  await call("build_record_feedback", {
    conversationId,
    contactId,
    channel: "web",
    question,
    sentiment: "negative",
    reason: "build-e2e evidence",
  })
  const now = Date.now()
  const analytics = record(
    await call("build_get_operational_analytics", {
      from: new Date(now - 60_000).toISOString(),
      to: new Date(now + 60_000).toISOString(),
    }),
    "operational analytics"
  )
  const events = records(analytics.eventsByType, "analytics event aggregates")
  const feedbackEvent = events.find((item) => item.eventType === "low_feedback")
  assert(
    feedbackEvent &&
      numberValue(feedbackEvent.count, "feedback event count") >= 1,
    "Analytics must include the negative feedback event."
  )
  const csat = record(analytics.csat, "analytics CSAT")
  assert(numberValue(csat.responses, "analytics CSAT responses") >= 1)

  const suggestions = record(
    await call("build_refresh_knowledge_gap_suggestions", { limit: 20 }),
    "knowledge-gap suggestions"
  )
  const suggestion = records(suggestions.items, "knowledge-gap items").find(
    (item) => item.question === question
  )
  assert(
    suggestion,
    "Negative feedback must produce a knowledge-gap suggestion."
  )
  assert(
    numberValue(suggestion.evidenceCount, "suggestion evidence count") >= 1
  )
  assert(
    numberValue(suggestion.negativeCount, "suggestion negative count") >= 1
  )
  passed(
    "HTTP analytics and knowledge-gap suggestions reflect negative feedback evidence"
  )
}
