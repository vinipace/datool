import type {
  ProjectPage,
  WorkspaceOrganization,
  WorkspaceProject,
} from "@/lib/workspace-api"
import type { WorkspaceScope } from "@/src/lib/auth/permissions"

export const storybookDate = "2026-09-11T12:00:00.000Z"

export const storybookOrganization = {
  id: "storybook-organization",
  name: "Northstar Labs",
  slug: "northstar-labs",
} satisfies WorkspaceOrganization

export const storybookOtherOrganization = {
  id: "storybook-other-organization",
  name: "Signal Foundry",
  slug: "signal-foundry",
} satisfies WorkspaceOrganization

/** Shape returned by Better Auth's organization endpoints in this application. */
export type StorybookAuthOrganization = WorkspaceOrganization & {
  createdAt: string
  metadata?: Record<string, unknown> | null
}

export const storybookAuthOrganizations = [
  { ...storybookOrganization, createdAt: storybookDate, metadata: null },
  {
    ...storybookOtherOrganization,
    createdAt: "2026-08-14T09:30:00.000Z",
    metadata: null,
  },
] satisfies StorybookAuthOrganization[]

export const storybookProject = {
  id: "storybook-project",
  organizationId: storybookOrganization.id,
  name: "Support copilot",
  slug: "support-copilot",
  createdAt: "2026-09-10T09:00:00.000Z",
  updatedAt: storybookDate,
  traceCount: 284,
  evalCount: 18,
  datasetCount: 6,
} satisfies WorkspaceProject

export const storybookOtherProject = {
  id: "storybook-other-project",
  organizationId: storybookOrganization.id,
  name: "Incident assistant",
  slug: "incident-assistant",
  createdAt: "2026-09-06T09:00:00.000Z",
  updatedAt: "2026-09-10T16:45:00.000Z",
  traceCount: 67,
  evalCount: 4,
  datasetCount: 2,
} satisfies WorkspaceProject

export const storybookProjects = [storybookProject, storybookOtherProject]

export const storybookProjectPage = {
  projects: storybookProjects,
  page: 1,
  pageSize: 25,
  total: storybookProjects.length,
} satisfies ProjectPage

export const storybookOrganizationRows = storybookAuthOrganizations.map(
  (organization, index) => ({
    ...organization,
    projectCount: index === 0 ? storybookProjects.length : 1,
    traceCount: index === 0 ? 1500 : 284,
    plan: index === 0 ? ("pro" as const) : ("core" as const),
  })
)

export const storybookMcpProjects = [
  {
    id: storybookProject.id,
    name: storybookProject.name,
    organizationName: storybookOrganization.name,
  },
  {
    id: storybookOtherProject.id,
    name: storybookOtherProject.name,
    organizationName: storybookOrganization.name,
  },
]

export const storybookMcpConnections = [
  {
    id: "consent-storybook-1",
    name: "Cursor",
    projectName: storybookProject.name,
    scopes: ["traces:read", "datasets:read"],
    createdAt: storybookDate,
  },
  {
    id: "consent-storybook-2",
    name: null,
    projectName: storybookOtherProject.name,
    scopes: ["evals:read"],
    createdAt: "2026-09-08T12:00:00.000Z",
  },
]

export type StorybookApiKey = {
  id: string
  name: string | null
  start: string | null
  prefix: string | null
  createdAt: string
  expiresAt: string | null
  enabled: boolean
  scopes: WorkspaceScope[]
  createdBy?: string | null
}

export type StorybookApiKeyList = {
  keys: StorybookApiKey[]
  canManage: boolean
  total: number
  creationDisabled: boolean
}

export const storybookApiKeys = [
  {
    id: "key-storybook-production",
    name: "Production tracing",
    start: "dtk_live_",
    prefix: null,
    createdAt: storybookDate,
    expiresAt: "2027-09-11T12:00:00.000Z",
    enabled: true,
    scopes: ["traces:write", "datasets:read"],
    createdBy: "Ana Martins",
  },
  {
    id: "key-storybook-readonly",
    name: "Reporting export",
    start: null,
    prefix: "dtk_",
    createdAt: "2026-09-08T12:00:00.000Z",
    expiresAt: null,
    enabled: true,
    scopes: ["metrics:read", "traces:read"],
    createdBy: "Ana Martins",
  },
] satisfies StorybookApiKey[]

export const storybookApiKeyList = {
  keys: storybookApiKeys,
  canManage: true,
  total: storybookApiKeys.length,
  creationDisabled: false,
} satisfies StorybookApiKeyList

export const storybookMemberApiKeyList = {
  keys: [],
  canManage: false,
  total: 0,
  creationDisabled: false,
} satisfies StorybookApiKeyList

/** Serializable representation returned by the project-record REST endpoints. */
export type StorybookProjectRecord = {
  id: string
  projectId: string
  kind: "trace" | "evaluation" | "prompt" | "dataset"
  name: string
  data: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export const storybookTraceRecord = {
  id: "record-storybook-trace",
  projectId: storybookProject.id,
  kind: "trace",
  name: "Refund workflow",
  data: { requestId: "req_storybook_42", summary: "Customer refund request" },
  createdAt: "2026-09-11T11:45:00.000Z",
  updatedAt: storybookDate,
} satisfies StorybookProjectRecord
