import { http, HttpResponse } from "msw"
import type { ProjectPage, WorkspaceProject } from "@/lib/workspace-api"
import {
  storybookApiKeyList,
  storybookAuthOrganizations,
  storybookDate,
  storybookMcpConnections,
  storybookMcpProjects,
  storybookProject,
  storybookProjectPage,
  type StorybookApiKeyList,
  type StorybookProjectRecord,
} from "./fixtures"

export const authBasePath = "/api/auth"

export function apiError(message: string, status = 500) {
  return HttpResponse.json({ error: { message } }, { status })
}

/** Better Auth surfaces errors as top-level `code` and `message` fields. */
export function betterAuthError(
  message: string,
  status = 500,
  code = "STORYBOOK_AUTH_ERROR"
) {
  return HttpResponse.json({ code, message, status }, { status })
}

/**
 * Browser-safe Better Auth responses shared by auth/workspace stories and the
 * TracerAppShell batch. They exercise the real `authClient` HTTP transport.
 */
export const storybookAuthHandlers = [
  http.get(`${authBasePath}/organization/list`, () =>
    HttpResponse.json(storybookAuthOrganizations)
  ),
  http.post(`${authBasePath}/organization/create`, async ({ request }) => {
    const body = (await request.json()) as { name?: string; slug?: string }
    return HttpResponse.json({
      id: "storybook-created-organization",
      name: body.name ?? "New organization",
      slug: body.slug ?? "new-organization",
      createdAt: storybookDate,
      metadata: null,
    })
  }),
  http.post(`${authBasePath}/organization/set-active`, () =>
    HttpResponse.json({ organization: storybookAuthOrganizations[0] })
  ),
  http.post(`${authBasePath}/sign-out`, () =>
    HttpResponse.json({ success: true })
  ),
  http.post(`${authBasePath}/sign-in/social`, () =>
    HttpResponse.json({ redirect: false, token: "storybook-session-token" })
  ),
  http.get(`${authBasePath}/oauth2/public-client`, ({ request }) => {
    const clientId = new URL(request.url).searchParams.get("client_id")
    return HttpResponse.json({
      client_id: clientId ?? "storybook-client",
      client_name: "Storybook MCP client",
    })
  }),
]

export function workspaceProjectHandlers({
  page = storybookProjectPage,
  createdProject = storybookProject,
}: {
  page?: ProjectPage
  createdProject?: WorkspaceProject
} = {}) {
  return [
    http.get("/api/organizations/:organizationId/projects", ({ request }) => {
      const search = new URL(request.url).searchParams
      const requestedPage = Number(search.get("page") ?? page.page)
      const requestedPageSize = Number(search.get("pageSize") ?? page.pageSize)
      return HttpResponse.json({
        ...page,
        page: Number.isFinite(requestedPage) ? requestedPage : page.page,
        pageSize: Number.isFinite(requestedPageSize)
          ? requestedPageSize
          : page.pageSize,
      })
    }),
    http.post(
      "/api/organizations/:organizationId/projects",
      async ({ request }) => {
        const body = (await request.json()) as { name?: string; slug?: string }
        return HttpResponse.json(
          {
            project: {
              ...createdProject,
              name: body.name ?? createdProject.name,
              slug: body.slug ?? createdProject.slug,
            },
          },
          { status: 201 }
        )
      }
    ),
  ]
}

export function apiKeyHandlers({
  response = storybookApiKeyList,
  createdKey = "dtk_storybook_new_key",
}: {
  response?: StorybookApiKeyList
  createdKey?: string
} = {}) {
  return [
    http.get("/api/organizations/:organizationId/api-keys", ({ request }) => {
      const offset = Number(
        new URL(request.url).searchParams.get("offset") ?? 0
      )
      const keys = response.keys.slice(offset, offset + 100)
      return HttpResponse.json({ data: { ...response, keys } })
    }),
    http.post("/api/organizations/:organizationId/api-keys", () =>
      HttpResponse.json({ data: { key: createdKey } }, { status: 201 })
    ),
    http.patch("/api/organizations/:organizationId/api-keys", () =>
      HttpResponse.json({ data: { creationDisabled: true } })
    ),
    http.delete("/api/organizations/:organizationId/api-keys/:keyId", () =>
      HttpResponse.json({ data: { revoked: true } })
    ),
  ]
}

export function mcpAuthorizationHandlers({
  projects = storybookMcpProjects,
  authorize = () =>
    apiError("Authorization was declined by the MCP client.", 400),
}: {
  projects?: typeof storybookMcpProjects
  authorize?: () => ReturnType<typeof apiError>
} = {}) {
  return [
    http.get("/api/mcp/authorization", () =>
      HttpResponse.json({ data: { projects } })
    ),
    http.post("/api/mcp/authorization", () => authorize()),
  ]
}

export function mcpConnectionHandlers({
  connections = storybookMcpConnections,
}: {
  connections?: typeof storybookMcpConnections
} = {}) {
  return [
    http.get("/api/organizations/:organizationId/mcp-connections", () =>
      HttpResponse.json({ data: connections })
    ),
    http.delete("/api/organizations/:organizationId/mcp-connections", () =>
      HttpResponse.json({ data: { revoked: true } })
    ),
  ]
}

export function dashboardRecordHandlers({
  records = [] as StorybookProjectRecord[],
}: {
  records?: StorybookProjectRecord[]
} = {}) {
  return [
    http.get("/api/projects/:projectId/records", () =>
      HttpResponse.json({
        records,
        page: 1,
        pageSize: 25,
        total: records.length,
      })
    ),
    http.post("/api/projects/:projectId/records", () =>
      HttpResponse.json({ record: records[0] }, { status: 201 })
    ),
    http.patch("/api/projects/:projectId/records/:recordId", () =>
      HttpResponse.json({ record: records[0] })
    ),
    http.delete(
      "/api/projects/:projectId/records/:recordId",
      () => new HttpResponse(null, { status: 204 })
    ),
  ]
}
