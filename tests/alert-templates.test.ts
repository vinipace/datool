import { expect, test } from "bun:test"
import { alertTemplates } from "../src/lib/alerts/templates"
import { parseAlertConfig } from "../src/server/alerts/service"
import { compileCollectionFilter } from "../src/lib/tracer/collection-filters"

test("alert templates all satisfy the server contract and use supported predicates", () => {
  expect(new Set(alertTemplates.map((template) => template.id)).size).toBe(6)
  for (const template of alertTemplates) {
    expect(parseAlertConfig(template.config)).toEqual(template.config)
    expect(template.config.action).toBe("in_app")
    expect(template.config.filter.length).toBeGreaterThan(0)
  }
  expect(
    alertTemplates.find((template) => template.id === "error-burst")?.config
  ).toMatchObject({ type: "time_window", threshold: 10, windowSeconds: 300 })
})
test("collection filters support alert rules and delivery history without accepting unknown fields", () => {
  expect(
    compileCollectionFilter(
      "alerts",
      "status = enabled type = time_window"
    )({ status: "enabled", type: "time_window" })
  ).toBe(true)
  expect(
    compileCollectionFilter(
      "alertNotifications",
      "status = failed attempts >= 3"
    )({ status: "failed", attempts: 2 })
  ).toBe(false)
  expect(() =>
    compileCollectionFilter("alertNotifications", "project_id = foreign")
  ).toThrow()
})
