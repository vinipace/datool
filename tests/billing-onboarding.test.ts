import { expect, test } from "bun:test"
import { NextRequest } from "next/server"
import { proxy, config } from "../proxy"
import { billingPath, billingPlanFromPath } from "../src/lib/billing"
import { workspaceReturnPath } from "../lib/workspace-routing"

test("billing return path survives the shared settings layout and ignores a spoofed header", () => {
  expect(config.matcher).toContain("/billing")
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
