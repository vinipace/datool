import type { Metadata } from "next"

/** Shared names for browser titles, navigation, and page headers. */
export const pageTitles = {
  pricing: "Pricing",
  billing: "Billing",
  usage: "Usage",
  members: "Members",
  organizationSettings: "General",
  invitation: "Invitation",
  organizations: "Organizations",
  newOrganization: "New organization",
  projects: "Projects",
  projectSettings: "Project settings",
  sandboxProviders: "Sandbox providers",
  aiProviders: "AI providers",
  alerts: "Alerts",
  newAlert: "New alert",
  alertDetail: "Alert notifications",
  editAlert: "Edit alert",
  projectSetup: "Create your first project",
  apiKeys: "API keys",
  mcpConnections: "MCP connections",
  traces: "Traces",
  traceDetail: "Trace details",
  playground: "Playground",
  playgroundApp: "Playground app",
  newApp: "New app",
  appDetail: "App settings",
  reports: "Reports",
  newReport: "New report",
  reportDetail: "Report",
  dashboards: "Dashboards",
  dashboardDetail: "Dashboard details",
  agents: "Agents",
  workflows: "Workflows",
  reviews: "Reviews",
  humanScores: "Human Scores",
  reviewSession: "Review session",
  sessions: "Sessions",
  sessionDetail: "Session details",
  evals: "Evals",
  evalDetail: "Eval run",
  datasets: "Datasets",
  datasetDetail: "Dataset details",
  prompts: "Prompts",
  newPrompt: "New prompt",
  promptDetail: "Prompt details",
  scorers: "Scorers",
  scorerDetail: "Scorer details",
  newScorer: "New scorer",
  signIn: "Sign in",
  mcpConnect: "Connect MCP",
  mcpConsent: "Authorize MCP access",
  uiReference: "UI reference",
} as const

export type PageKey = keyof typeof pageTitles

/** The brand suffix belongs only to the root layout. */
export const rootMetadata: Metadata = {
  applicationName: "Datool",
  title: {
    default: "Datool",
    template: "%s · Datool",
  },
}

export function pageMetadata(page: PageKey): Metadata {
  return { title: pageTitles[page] }
}
