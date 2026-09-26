import { describe, expect, test } from "bun:test"
import { workspacePrefix, workspaceReturnPath } from "../lib/workspace-routing"
import { projectHref } from "../lib/workspace-api"
describe("workspace route boundaries", () => {
  test("retains the selected organization and project for every child page", () => {
    for (const child of [
      "",
      "/projects",
      "/traces",
      "/evals/run-1",
      "/datasets/data-1",
      "/dashboards/dash_123",
      "/alerts",
      "/alerts/new",
      "/alerts/alert_123",
      "/alerts/alert_123/edit",
      "/scorers/new",
      "/scorers/scorer_123",
    ]) {
      expect(workspacePrefix(`/p/project-one${child}`)).toBe(
        "/p/project-one"
      )
    }
  })
  test("does not scope organization settings or similarly named paths as projects", () => {
    for (const path of [
      "/",
      "/api-keys",
      "/settings/mcp",
      "/acme/api-keys",
    ])
      expect(workspacePrefix(path)).toBeNull()
  })
  test("rejects removed workspace routes", () => {
    expect(workspacePrefix("/workspace/org-id/project-id/traces")).toBeNull()
    expect(workspacePrefix("/acme/p/project-one/traces")).toBeNull()
  })
})

test("View all projects retains the active project in its route", () => {
  const organization = { id: "org-id", slug: "acme", name: "Acme" }
  const project = { slug: "selected-project" }
  const projectsUrl = projectHref(organization, project, "projects")
  expect(projectsUrl).toBe("/p/selected-project/projects")
  expect(workspacePrefix(projectsUrl)).toBe(
    workspacePrefix(projectHref(organization, project))
  )
})

test("API requests use the resolved ID, never the URL slug or a stale project's ID", async () => {
  const { projectFetch } = await import("../lib/workspace-routing")
  const previous = {
    window: Object.getOwnPropertyDescriptor(globalThis, "window"),
    document: Object.getOwnPropertyDescriptor(globalThis, "document"),
    fetch: globalThis.fetch,
  }
  const location = { pathname: "/p/readable-name/traces" }
  const requests: Headers[] = []
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location },
    })
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        querySelector: () => ({
          dataset: {
            projectId: "database-project-id",
            organizationId: "database-org-id",
            projectPrefix: "/p/readable-name",
          },
        }),
      },
    })
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      requests.push(new Headers(init?.headers))
      return new Response("{}")
    }) as typeof fetch
    await projectFetch("/api/traces", {
      headers: { "Content-Type": "application/json" },
    })
    expect(requests[0].get("x-project-id")).toBe("database-project-id")
    expect(requests[0].get("Content-Type")).toBe("application/json")
    location.pathname = "/p/another/traces"
    await projectFetch("/api/traces")
    expect(requests[1].has("x-project-id")).toBe(false)
    await projectFetch("/api/datasets/library?scope=tree", undefined, "database-project-id")
    expect(requests[2].get("x-project-id")).toBe("database-project-id")
  } finally {
    globalThis.fetch = previous.fetch
    for (const key of ["window", "document"] as const) {
      if (previous[key]) Object.defineProperty(globalThis, key, previous[key]!)
      else Reflect.deleteProperty(globalThis, key)
    }
  }
})

test("workspace return paths preserve deep links and reject external destinations", () => {
  expect(workspaceReturnPath("/p/demo/traces/t1?span=s1")).toBe("/p/demo/traces/t1?span=s1")
  for (const value of ["https://outside.test/app", "//outside.test/app", "/p/../../outside", "/p\\outside"]) {
    expect(workspaceReturnPath(value)).toBe("/")
  }
})
