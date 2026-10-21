import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"

import {
  buildOperationCatalog,
  buildOperations,
  executeBuildOperation,
} from "@/src/server/build/bootstrap"
import { routeScopes } from "@/src/server/auth/request"
import { withWorkspace } from "@/src/server/auth/context"

const previousBuildEnabled = process.env.DATOOL_BUILD_ENABLED
beforeEach(() => {
  process.env.DATOOL_BUILD_ENABLED = "true"
})
afterEach(() => {
  if (previousBuildEnabled === undefined) delete process.env.DATOOL_BUILD_ENABLED
  else process.env.DATOOL_BUILD_ENABLED = previousBuildEnabled
})

describe("Build operation HTTP contract", () => {
  test("disabled Build rejects a granted operation before accessing project data", async () => {
    delete process.env.DATOOL_BUILD_ENABLED
    await withWorkspace(
      { organizationId: "org-test", projectId: "project-test", userId: "user-test", kind: "oauth", scopes: ["build:read"] },
      async () => {
        await assert.rejects(executeBuildOperation("build_list_agents", {}), (error) => {
          expect(error).toMatchObject({ code: "NOT_FOUND", status: 404, message: "Build is disabled on this installation." })
          return true
        })
      }
    )
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
