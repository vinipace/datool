import { expect, test } from "bun:test"
import { billingPath, billingPlanFromPath } from "../src/lib/billing"
import { workspaceReturnPath } from "../lib/workspace-routing"

// Next captures AsyncLocalStorage during module initialization. Bootstrap its
// server environment before loading the request utilities or the app proxy.
await import("next/dist/server/node-environment")
const { NextRequest } = await import("next/server")
const { unstable_doesMiddlewareMatch } = await import("next/experimental/testing/server")
const { proxy, config } = await import("../proxy")

test("billing return path survives the shared settings layout and ignores a spoofed header", () => {
  expect(unstable_doesMiddlewareMatch({ config, url: "/billing?plan=pro" })).toBe(true)
  for (const plan of ["core", "pro"] as const) {
    const path = billingPath(plan, "canceled")
    const request = new NextRequest(`http://localhost:3000${path}&_rsc=cache`, {
      headers: { "x-datool-workspace-path": "https://outside.test" },
    })
    const response = proxy(request)
    const forwarded = response.headers.get(
      "x-middleware-request-x-datool-workspace-path"
    )
    expect(workspaceReturnPath(forwarded, "/settings/general")).toBe(path)
    expect(billingPlanFromPath(forwarded!)).toBe(plan)
  }
})

test("only explicit internal plan choices become billing intent", () => {
  for (const path of [
    "/billing",
    "/billing?plan=unknown",
    "//outside.test/billing?plan=pro",
    "https://outside.test/billing?plan=pro",
    "/projects?plan=pro",
  ])
    expect(billingPlanFromPath(path)).toBeNull()
  expect(billingPlanFromPath("/billing?plan=pro&checkout=success")).toBe("pro")
})
