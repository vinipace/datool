import { afterEach, describe, expect, test } from "bun:test"
import { NextRequest } from "next/server"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"
import { config, proxy } from "../proxy"
import { createServer } from "node:net"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { setTimeout } from "node:timers/promises"

const previousBuildEnabled = process.env.DATOOL_BUILD_ENABLED
afterEach(() => {
  if (previousBuildEnabled === undefined)
    delete process.env.DATOOL_BUILD_ENABLED
  else process.env.DATOOL_BUILD_ENABLED = previousBuildEnabled
})

describe("Build runtime opt-in", () => {
  test("disabled worker stays alive without opening a database connection and stops cleanly", async () => {
    let connections = 0
    const database = createServer((socket) => {
      connections++
      socket.destroy()
    })
    await new Promise<void>((resolve) =>
      database.listen(0, "127.0.0.1", resolve)
    )
    const address = database.address() as import("node:net").AddressInfo
    const worker = spawn(
      process.execPath,
      ["--no-env-file", "scripts/build-worker.ts"],
      {
        env: {
          PATH: process.env.PATH,
          NODE_ENV: "test",
          DATABASE_URL: `postgresql://fixture:fixture@127.0.0.1:${address.port}/fixture`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }
    )
    const exited = once(worker, "exit")
    let errors = ""
    worker.stderr.on("data", (chunk) => {
      errors += String(chunk)
    })
    try {
      const [started] = await once(worker.stdout, "data")
      expect(String(started)).toContain("[build-worker] disabled;")
      await setTimeout(300)
      expect(worker.exitCode).toBeNull()
      expect(connections).toBe(0)
      worker.kill("SIGTERM")
      expect((await exited)[0]).toBe(0)
      expect(errors).toBe("")
    } finally {
      if (worker.exitCode === null) worker.kill("SIGKILL")
      await exited
      await new Promise<void>((resolve) => database.close(() => resolve()))
    }
  }, 15_000)

  for (const value of [undefined, "", "false", "1", "TRUE", "yes"]) {
    test(`Build routes return 404 when DATOOL_BUILD_ENABLED=${String(value)}`, async () => {
      if (value === undefined) delete process.env.DATOOL_BUILD_ENABLED
      else process.env.DATOOL_BUILD_ENABLED = value
      for (const [path, method] of [
        ["/p/project/build", "GET"],
        ["/p/project/build/agents", "GET"],
        ["/p/project/build/agents/agent/test", "GET"],
        ["/p/project/build/inbox?view=mine", "HEAD"],
        ["/chat/channel", "GET"],
        ["/api/build/build_list_agents", "POST"],
        ["/api/build-public/channel/session", "POST"],
        ["/api/build-public/channel/appearance", "OPTIONS"],
        ["/api/build-webhooks/whatsapp", "GET"],
        ["/api/build-webhooks/telegram/connection", "POST"],
      ]) {
        expect(
          unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path })
        ).toBe(true)
        const response = await proxy(
          new NextRequest(`https://datool.test${path}`, { method })
        )
        expect(response.status).toBe(404)
        expect(response.headers.get("Cache-Control")).toBe("no-store")
        if (path.startsWith("/api/")) {
          expect(await response.json()).toMatchObject({
            error: { code: "NOT_FOUND" },
          })
        }
      }
    })
  }

  test("explicit true enables Build routes at runtime", async () => {
    process.env.DATOOL_BUILD_ENABLED = "true"
    for (const path of [
      "/p/project/build/agents",
      "/api/build/build_list_agents",
      "/api/build-public/channel/session",
      "/api/build-webhooks/whatsapp",
    ]) {
      const response = await proxy(
        new NextRequest(`https://datool.test${path}`)
      )
      expect(response.headers.get("x-middleware-next")).toBe("1")
    }
  })

  test("disabled Build preserves Observe, Test, settings, and unrelated APIs", async () => {
    delete process.env.DATOOL_BUILD_ENABLED
    for (const path of [
      "/p/project/traces",
      "/p/project/evals",
      "/p/project/settings",
      "/p/build/traces",
    ]) {
      const response = await proxy(
        new NextRequest(`https://datool.test${path}`)
      )
      expect(response.headers.get("x-middleware-next")).toBe("1")
    }
    for (const path of [
      "/api/traces",
      "/api/evals",
      "/api/mcp",
      "/api/building",
    ]) {
      expect(
        unstable_doesMiddlewareMatch({ config, nextConfig: {}, url: path })
      ).toBe(false)
    }
  })
})
