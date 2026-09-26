import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import fixture from "./fixtures/codex/canary.json"
import { CodexCollector } from "../src/lib/codex-traces/collector"
import { codexEnvironment } from "../src/lib/codex-traces/environment"

test("observed Codex inherits its login environment without Datool credentials", () => {
  expect(
    codexEnvironment({
      NODE_ENV: "test",
      PATH: "/usr/bin",
      CODEX_HOME: "/tmp/codex",
      OPENAI_API_KEY: "codex-login",
      DATOOL_API_KEY: "datool-secret",
      DATOOL_PROJECT_ID: "private",
      DATABASE_URL: "database-secret",
      REDIS_URL: "redis-secret",
      BETTER_AUTH_SECRET: "auth-secret",
    })
  ).toEqual({
    NODE_ENV: "test",
    PATH: "/usr/bin",
    CODEX_HOME: "/tmp/codex",
    OPENAI_API_KEY: "codex-login",
  })
})

test("collector authenticates, journals before acknowledgement, deduplicates retries and protects destination binding", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "datool-codex-test-"))
  const options = {
    stateDir,
    baseUrl: "http://localhost:3000",
    projectId: "project-test",
    apiKey: "test-only",
  }
  const collector = new CodexCollector(options)
  try {
    await collector.initialize()
    const { collectorToken } = JSON.parse(
      await readFile(join(stateDir, "destination.json"), "utf8")
    )
    const request = (
      token = collectorToken,
      body = JSON.stringify(fixture.traces),
      extra: Record<string, string> = {}
    ) =>
      new Request("http://127.0.0.1:4318/v1/traces", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          ...extra,
        },
        body,
      })
    expect((await collector.receive(request("wrong"))).status).toBe(401)
    expect(
      (
        await collector.receive(
          request(collectorToken, "{}", { origin: "https://untrusted.example" })
        )
      ).status
    ).toBe(401)
    expect(
      (
        await collector.receive(
          request(collectorToken, "{}", {
            "content-type": "application/x-protobuf",
          })
        )
      ).status
    ).toBe(415)
    expect(
      (await collector.receive(request(collectorToken, "{}"))).status
    ).toBe(400)
    expect((await collector.receive(request())).status).toBe(200)
    expect((await collector.receive(request())).status).toBe(200)
    const files = await readdir(join(stateDir, "journal"))
    expect(files).toHaveLength(1)
    expect(
      JSON.parse(await readFile(join(stateDir, "journal", files[0]), "utf8"))
        .body
    ).toEqual(fixture.traces)
    expect((await stat(join(stateDir, "journal", files[0]))).mode & 0o777).toBe(
      0o600
    )
    const changed = new CodexCollector({
      ...options,
      projectId: "another-project",
    })
    await rejects(changed.initialize(), /different Datool destination/)
    changed.close()
    const restarted = new CodexCollector(options)
    await restarted.initialize()
    expect(restarted.configuration("http://127.0.0.1:4318")).toContain(
      collectorToken
    )
    restarted.close()
  } finally {
    collector.close()
    await rm(stateDir, { recursive: true, force: true })
  }
})
