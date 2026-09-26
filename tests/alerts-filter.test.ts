import { expect, test } from "bun:test"
import { parseAlertFilter, compileAlertFilter } from "../src/lib/alerts/filter"
import { parseAlertConfig } from "../src/server/alerts/service"
import { defaultAlertConfig } from "../src/lib/alerts/contracts"
import {
  isPublicAlertAddress,
  validateWebhookUrl,
} from "../src/server/alerts/webhook"

test("alert filters preserve precedence and bind fields, values, and flat attribute keys", () => {
  const parsed = parseAlertFilter(
    "status = 'errored' OR kind = 'llm' AND duration_ms > 5000"
  )
  expect(parsed).toMatchObject({ join: "OR", right: { join: "AND" } })
  const values: unknown[] = []
  const sql = compileAlertFilter(
    "span_attributes.gen_ai.request.model = 'gpt-5' AND name = 'it''s broken'",
    values
  )
  expect(sql).not.toContain("gpt-5")
  expect(sql).not.toContain("gen_ai.request.model")
  expect(values).toEqual([
    "gen_ai.request.model",
    "gpt-5",
    "name",
    "it's broken",
  ])
  expect(parseAlertFilter('span_attributes.type = "llm"')).toMatchObject({
    value: "llm",
  })
  expect(parseAlertFilter("created > now() - interval 1 day")).toMatchObject({
    relativeSeconds: 86400,
  })
  expect(
    parseAlertFilter("created > now() - interval '2 hours'")
  ).toMatchObject({ relativeSeconds: 7200 })
  expect(parseAlertFilter("cost_usd >= -1")).toMatchObject({ value: -1 })
  expect(parseAlertFilter("kind IS NOT NULL")).toMatchObject({
    operator: "IS NOT NULL",
  })
})

test("alert filters reject statements, unsupported fields/functions, injection and unbounded input", () => {
  for (const filter of [
    "status = 'errored'; DROP TABLE traces",
    "1=1",
    "status = 'errored' -- x",
    "project_id = 'other'",
    "pg_sleep(10)",
    "name = (SELECT name FROM project)",
    "duration_ms > 'slow'",
    "created LIKE 'x'",
    "name = 'x' UNION SELECT 1",
    "(".repeat(20) + "name = 'a'" + ")".repeat(20),
    "status = 'running' ".repeat(200),
  ]) {
    expect(() => parseAlertFilter(filter)).toThrow()
  }
})

test("alert validation rejects empty names, invalid limits and restricted webhook targets", () => {
  expect(() => parseAlertConfig(defaultAlertConfig)).toThrow()
  expect(() =>
    parseAlertConfig({
      ...defaultAlertConfig,
      name: "Errors",
      notifyIntervalSeconds: 0,
    })
  ).toThrow()
  for (const url of [
    "http://example.com",
    "https://127.0.0.1",
    "https://169.254.169.254/latest",
    "https://[::1]/",
    "https://user:password@example.com",
    "file:///tmp/x",
    "https://localhost/",
  ]) {
    expect(() => validateWebhookUrl(url)).toThrow()
  }
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.1.1",
    "192.168.1.1",
    "100.100.100.200",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "2002:7f00:1::",
  ])
    expect(isPublicAlertAddress(address)).toBe(false)
  expect(isPublicAlertAddress("8.8.8.8")).toBe(true)
  expect(isPublicAlertAddress("2606:4700:4700::1111")).toBe(true)
})

test("seeded hostile-input fuzzing keeps user bytes out of SQL and terminates within grammar limits", () => {
  let seed = 0xc0defeed
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed
  }
  const fragments = [
    "'",
    '"',
    ";",
    "--",
    "/*",
    "*/",
    " UNION SELECT ",
    "pg_sleep(99)",
    "$1",
    "$x$",
    "\\",
    "\n",
    "\0",
    "😈",
    " OR true ",
    "::text",
    " DROP TABLE traces ",
  ]
  for (let i = 0; i < 3000; i++) {
    const value =
      `sentinel_${i}_` +
      Array.from(
        { length: 1 + (random() % 8) },
        () => fragments[random() % fragments.length]
      ).join("")
    const quoted = `name = '${value.replaceAll("'", "''")}'`
    const parameters: unknown[] = []
    if (value.includes("\0"))
      expect(() => compileAlertFilter(quoted, parameters)).toThrow()
    else {
      const sql = compileAlertFilter(quoted, parameters)
      expect(sql).not.toContain(`sentinel_${i}_`)
      expect(parameters).toEqual(["name", value])
    }
    const unquoted =
      `name = '${value}'` + fragments[random() % fragments.length]
    let compiled: string
    try {
      compiled = compileAlertFilter(unquoted, [])
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      continue
    }
    expect(compiled).not.toContain(`sentinel_${i}_`)
    expect(compiled).not.toContain("pg_sleep")
    expect(compiled).not.toContain(";")
  }
  for (const invalid of [
    "created = '0'",
    "created = '0000-01-01'",
    "created = '2026-02-30'",
    "created = 'today'",
    "name LIKE 'x\\'",
    " ".repeat(2001),
  ])
    expect(() => parseAlertFilter(invalid)).toThrow()
  expect(
    parseAlertFilter("created = '2026-09-17T01:00:00-03:00'")
  ).toMatchObject({ value: "2026-09-17T04:00:00.000Z" })
})
