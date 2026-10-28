import { configureBuildTestEnvironment } from "./helpers/build-env"
import { describe, expect, spyOn, test } from "bun:test"
import assert from "node:assert/strict"

import {
  buildOperationCatalog,
  buildOperations,
  executeBuildOperation,
} from "@/src/server/build/bootstrap"
import { routeScopes } from "@/src/server/auth/request"
import { withWorkspace } from "@/src/server/auth/context"

configureBuildTestEnvironment()

describe("Build operation HTTP contract", () => {
  test("an unavailable audit sink preserves the original authorization result", async () => {
    const log = spyOn(console, "info").mockImplementation(() => { throw new Error("Log sink unavailable") })
    try {
      await withWorkspace({ organizationId: "org-audit", projectId: "project-audit", userId: "user-audit", kind: "session", scopes: ["build:read"] }, async () => {
        await assert.rejects(executeBuildOperation("build_create_agent", {}), { status: 403, code: "UNAUTHORIZED" })
      })
    } finally { log.mockRestore() }
  })
  test("denied operations audit the authenticated caller without recording supplied customer data", async () => {
    const lines: string[] = []
    const log = spyOn(console, "info").mockImplementation((line: unknown) => { lines.push(String(line)) })
    try {
      await withWorkspace({ organizationId: "org-audit", projectId: "project-audit", userId: "user-audit", clientId: "client-audit", kind: "oauth", scopes: ["build:read"] }, async () => {
        await assert.rejects(executeBuildOperation("build_create_agent", { name: "private-customer@example.test", organizationId: "forged-org", token: "private-token" }), { status: 403 })
        await assert.rejects(executeBuildOperation("private-customer@example.test", {}))
      })
      const events = lines.map(line => JSON.parse(line))
      expect(events).toHaveLength(2)
      expect(events[0]).toMatchObject({ event: "security_audit", version: 1, action: "build_create_agent", outcome: "denied", status: 403, organizationId: "org-audit", projectId: "project-audit", actorType: "oauth", actorId: "user-audit", clientId: "client-audit" })
      assert.match(events[0].timestamp, /^\d{4}-\d{2}-\d{2}T/)
      expect(typeof events[0].eventId).toBe("string")
      expect(events[1].action).toBe("build.unknown")
      const serialized = JSON.stringify(events)
      for (const privateValue of ["private-customer", "forged-org", "private-token"])
        expect(serialized).not.toContain(privateValue)
    } finally { log.mockRestore() }
  })

  test("disabled Build rejects a granted operation before accessing project data", async () => {
    delete process.env.DATOOL_BUILD_ENABLED
    await withWorkspace(
      { organizationId: "org-test", projectId: "project-test", userId: "user-test", kind: "oauth", scopes: ["build:read"] },
      async () => {
        await assert.rejects(executeBuildOperation("build_list_agents", {}), (error) => {
          expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, message: "Build is disabled for this organization." })
          return true
        })
      }
    )
  })

  test("allowlist uses authorized organization identity, never an input override", async () => {
    process.env.DATOOL_BUILD_ENABLED = "false"
    process.env.DATOOL_BUILD_ORGANIZATION_IDS = "org-allowed"
    const identity = { organizationId: "org-excluded", projectId: "project-test", userId: "user-test", kind: "oauth" as const, scopes: ["build:read"] }
    await withWorkspace(identity, async () => {
      await assert.rejects(executeBuildOperation("build_list_agents", { organizationId: "org-allowed" }), (error) => {
        expect(error).toMatchObject({ code: "NOT_FOUND", status: 404 })
        return true
      })
    })
    // The same operation still enforces permissions after organization admission.
    await withWorkspace({ ...identity, organizationId: "org-allowed" }, async () => {
      await assert.rejects(executeBuildOperation("build_create_agent", {}), (error) => {
        expect(error).toMatchObject({ code: "UNAUTHORIZED", status: 403, details: { reason: "INSUFFICIENT_SCOPE" } })
        return true
      })
    })
  })

  test("publishes a unique, scoped operation catalog with retry metadata", () => {
    const names = buildOperations.map((operation) => operation.name)
    expect(new Set(names).size).toBe(names.length)
    expect(names.every((name) => /^build_[a-z][a-z0-9_]{1,119}$/.test(name))).toBe(true)
    expect(
      buildOperations.every((operation) =>
        operation.scopes.every((scope) =>
          ["build:read", "build:write", "build:run"].includes(scope)
        )
      )
    ).toBe(true)

    const writeCatalog = buildOperationCatalog(["build:write"])
    expect(writeCatalog.some((operation) => operation.name === "build_describe_operations")).toBe(true)
    expect(
      buildOperationCatalog(["build:run"]).some(
        (operation) => operation.name === "build_describe_operations"
      )
    ).toBe(true)
    const updateAgent = writeCatalog.find(
      (operation) => operation.name === "build_update_agent"
    )
    expect(updateAgent?.idempotency).toBe("required")
    expect(updateAgent?.expectedRevision).toBe("required")
    expect(updateAgent?.maxInputBytes).toBeGreaterThan(0)
    expect(updateAgent?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        idempotencyKey: { type: "string" },
        requestKey: { type: "string" },
      },
    })

    const knowledge = buildOperationCatalog(["build:write"]).find(
      (operation) => operation.name === "build_create_knowledge_source"
    )
    expect(knowledge?.maxInputBytes).toBe(32 * 1024 * 1024)
  })

  test("requires expectedRevision anywhere the registry advertises it", () => {
    for (const operation of buildOperations.filter(
      (candidate) => candidate.expectedRevision === "required",
    )) {
      const published = buildOperationCatalog().find(
        (candidate) => candidate.name === operation.name,
      )
      assert(published)
      const schema = published.inputSchema as {
        properties?: Record<string, { type?: unknown }>
        required?: unknown[]
      }
      assert.equal(schema.properties?.expectedRevision?.type, "integer")
      assert(schema.required?.includes("expectedRevision"))
    }
  })

  test("classifies only registered Build POST operations and fails closed", async () => {
    expect(
      await routeScopes(
        new Request("https://datool.example/api/build/build_list_agents", {
          method: "POST",
        })
      )
    ).toEqual(["build:read"])

    await assert.rejects(
      routeScopes(
        new Request("https://datool.example/api/build/build_list_agents", {
          method: "GET",
        })
      ),
      (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "UNAUTHORIZED" &&
          "status" in error &&
          error.status === 403
      )
    )
    await assert.rejects(
      routeScopes(
        new Request("https://datool.example/api/build/unknown_operation", {
          method: "POST",
        })
      ),
      (error: unknown) =>
      Boolean(
        error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "UNAUTHORIZED" &&
          "status" in error &&
          error.status === 403
      )
    )
  })

  test("enforces the operation scope again at the domain transport boundary", async () => {
    await withWorkspace(
      {
        organizationId: "org-test",
        projectId: "project-test",
        userId: "user-test",
        kind: "oauth",
        scopes: ["build:read"],
      },
      async () => {
        await assert.rejects(
          executeBuildOperation("build_create_agent", { name: "Should fail" }),
          (error: unknown) => {
          expect(error).toMatchObject({
            code: "UNAUTHORIZED",
            status: 403,
            details: {
              reason: "INSUFFICIENT_SCOPE",
              missingScopes: ["build:write"],
            },
          })
          return true
        })
      }
    )
  })

  test("treats blank transport idempotency values as missing", async () => {
    await withWorkspace(
      {
        organizationId: "org-test",
        projectId: "project-test",
        userId: "user-test",
        kind: "oauth",
        scopes: ["build:write"],
      },
      async () => {
        await assert.rejects(
          executeBuildOperation("build_update_agent", {
            agentId: "agent-test",
            expectedRevision: 1,
            idempotencyKey: "   ",
          }),
          /idempotency key is required/
        )
      }
    )
  })
})
