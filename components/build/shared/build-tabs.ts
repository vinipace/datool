export type BuildTab = {
  id: string
  label: string
  description: string
  group: "Setup" | "Build" | "Release"
}

/**
 * Keep stable ids for deep links and saved drafts while presenting sections
 * in a smaller, task-oriented hierarchy.
 */
export const agentBuildTabs: BuildTab[] = [
  {
    id: "overview",
    label: "Overview",
    description: "Activity and customer experience",
    group: "Setup",
  },
  {
    id: "instructions",
    label: "Instructions",
    description: "Behavior and model",
    group: "Setup",
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Welcome and visual style",
    group: "Setup",
  },
  {
    id: "guardrails",
    label: "Guardrails",
    description: "Safety, usage and abuse limits",
    group: "Setup",
  },
  {
    id: "copilot",
    label: "Copilot",
    description: "Draft with an assistant",
    group: "Setup",
  },
  {
    id: "knowledge",
    label: "Knowledge",
    description: "Sources your agent can use",
    group: "Build",
  },
  {
    id: "actions",
    label: "Actions",
    description: "Things the agent can do",
    group: "Build",
  },
  {
    id: "procedures",
    label: "Procedures",
    description: "Repeatable workflows",
    group: "Build",
  },
  {
    id: "widgets",
    label: "Widgets",
    description: "Interactive responses",
    group: "Build",
  },
  {
    id: "channels",
    label: "Channels",
    description: "Where customers reach you",
    group: "Release",
  },
  {
    id: "playground",
    label: "Playground",
    description: "Try the applied agent",
    group: "Release",
  },
  {
    id: "settings",
    label: "Settings",
    description: "Identity and revision history",
    group: "Setup",
  },
]

export const agentBuildTabGroups = ["Setup", "Build", "Release"] as const
