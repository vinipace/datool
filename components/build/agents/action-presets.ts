import {
  buildChannelSchema,
  type ActionDefinition,
} from "@/src/lib/build/contracts"

export type ActionPreset = ActionDefinition["type"] | "leads" | "data"

export function withActionType(
  current: ActionDefinition,
  type: ActionDefinition["type"]
): ActionDefinition {
  if (current.type === type) return current
  const base = {
    id: current.id,
    name: current.name,
    description: current.description,
    enabled: current.enabled,
    channels: current.channels,
    procedureOnly: current.procedureOnly,
    inputSchema: current.inputSchema,
  }
  switch (type) {
    case "integration":
      return { ...base, type, connectionId: "", toolSlug: "" }
    case "http":
      return {
        ...base,
        type,
        method: "POST",
        url: "",
        headers: {},
        bodyTemplate: '{"input": {{input}}}',
        responseSchema: {},
        timeoutMs: 10_000,
      }
    case "client":
      return { ...base, type, eventName: "client_event", resultSchema: {} }
    case "widget":
      return {
        ...base,
        type,
        widgetId: "",
        eventName: "widget_event",
        resultSchema: {},
      }
    case "form":
      return {
        ...base,
        type,
        captureLead: false,
        submitLabel: "Submit",
        fields: [],
        submitActionId: null,
      }
    case "handoff":
      return {
        ...base,
        type,
        teamId: null,
        message: "I'll connect you with a teammate.",
        priority: "normal",
      }
  }
}

export function newActionDraft(preset: ActionPreset): ActionDefinition {
  const draft = withActionType(
    {
      id: `action-${crypto.randomUUID()}`,
      name: "",
      description: "",
      enabled: true,
      channels: [...buildChannelSchema.options],
      procedureOnly: false,
      inputSchema: {},
      type: "http",
      method: "POST",
      url: "",
      headers: {},
      bodyTemplate: '{"input": {{input}}}',
      responseSchema: {},
      timeoutMs: 10_000,
    },
    preset === "leads" || preset === "data" ? "form" : preset
  )

  if (draft.type === "form") {
    if (preset === "leads")
      return {
        ...draft,
        name: "Collect leads",
        captureLead: true,
        description:
          "Collect the customer's name and email when they want the team to follow up.",
        submitLabel: "Send details",
        fields: [
          {
            name: "name",
            label: "Your name",
            type: "text",
            required: true,
            options: [],
          },
          {
            name: "email",
            label: "Email address",
            type: "email",
            required: true,
            options: [],
          },
          {
            name: "phone",
            label: "Phone number",
            type: "phone",
            required: false,
            options: [],
          },
        ],
      }
    return {
      ...draft,
      name: preset === "data" ? "Collect data" : "Custom form",
      fields: [
        {
          name: "field_1",
          label: "Field 1",
          type: "text",
          required: false,
          options: [],
        },
      ],
    }
  }
  if (draft.type === "handoff")
    return {
      ...draft,
      name: "Talk to a teammate",
      description:
        "Hand off to the team when a customer asks for a person or needs help the agent cannot provide.",
    }
  if (draft.type === "widget")
    return {
      ...draft,
      name: "Show Widget",
      description:
        "Show this widget when it helps the customer take the next step in the conversation.",
    }
  return draft
}
