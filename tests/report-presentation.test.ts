import { expect, test } from "bun:test"
import { routeScopes } from "../src/server/auth/request"
import {
  reportMetricChange,
  reportTargetStatus,
  reportBestValue,
} from "../src/lib/tracer/report-layouts"

test("comparison highlights respect direction, ties, and missing values", () => {
  expect(reportBestValue([0.3, 0.95, 0.95, null], "higher")).toBe(0.95)
  expect(reportBestValue([10, 12, 7.2, 3.6], "lower")).toBe(3.6)
  expect(reportBestValue([-4, -2, 0], "higher")).toBe(0)
  expect(reportBestValue([-4, -2, 0], "lower")).toBe(-4)
  expect(reportBestValue([null, undefined, NaN, Infinity], "higher")).toBeNull()
  expect(reportBestValue([1, 2], "neutral")).toBeNull()
})

test("MDX draft edits require dashboard write and metric read access", async () => {
  expect(
    await routeScopes(
      new Request("http://localhost/api/reports/12/update", {
        method: "POST",
      })
    )
  ).toEqual(["dashboards:write", "metrics:read"])
})

test("layout comparisons handle rate differences, lower-is-better, missing values and zero baselines", () => {
  expect(reportMetricChange(0.95, 0.3, "higher", true)).toMatchObject({
    unit: "pp",
    tone: "positive",
  })
  expect(reportMetricChange(3.6, 10, "lower", false)).toMatchObject({
    amount: -64,
    tone: "positive",
  })
  expect(reportMetricChange(12, 10, "lower", false)).toMatchObject({
    amount: 20,
    tone: "negative",
  })
  expect(reportMetricChange(2, 0, "lower", false)).toMatchObject({
    amount: 2,
    unit: "absolute",
  })
  expect(reportMetricChange(null, 0, "higher", true)).toBeNull()
  expect(reportTargetStatus(null, 0.9, "higher")).toBe("missing")
  expect(reportTargetStatus(0.95, undefined, "higher")).toBe("unconfigured")
  expect(reportTargetStatus(0.95, 0.95, "higher")).toBe("met")
  expect(reportTargetStatus(3.6, 4, "lower")).toBe("met")
  expect(reportTargetStatus(5, 4, "lower")).toBe("missed")
})
