import { spawn, execFile } from "node:child_process"
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { expect } from "bun:test"

/** Boat's documented HTTP protocol over real Docker workloads. Only allocation,
 * API auth and VM state are simulated; command/file/volume behavior is real. */
export async function boatFixture() {
  const directory = await mkdtemp(join(tmpdir(), "datool-boat-test-"))
  const originalFetch = globalThis.fetch
  const realDocker = (
    await promisify(execFile)("which", ["docker"])
  ).stdout.trim()
  await writeFile(
    join(directory, "docker"),
    `#!/usr/bin/env python3
import os,sys
args=sys.argv[1:]; prefix=os.environ['BOAT_TEST_VM']+'-'
for i,a in enumerate(args):
 if a.startswith('datool-') and not a.startswith('datool.project=') and not a.startswith('datool.turn=') and not a.startswith('datool.kind=') and not a.startswith('datool.drive='): args[i]=prefix+a
 if a.startswith('type=volume,src='): args[i]=a.replace('src=','src='+prefix,1)
os.execv(${JSON.stringify(realDocker)},[${JSON.stringify(realDocker)}]+args)
`,
    { mode: 0o700 }
  )
  const boxes = new Map<
    string,
    { state: string; key: string; snapshots: boolean }
  >()
  const processes = new Map<
    number,
    {
      child: ReturnType<typeof spawn>
      out: Buffer
      err: Buffer
      exit: number | null
    }
  >()
  const inputs = new Set<string>()
  let sequence = 0,
    lostCreate = false,
    failCapture = false
  const faults = {
    loseNextCreate: () => {
      lostCreate = true
    },
    failNextCapture: () => {
      failCapture = true
    },
  }
  async function request(
    input: string | URL | Request,
    init?: RequestInit
  ): Promise<Response> {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (url.hostname !== "boat.dev") return originalFetch(input, init)
    expect(request.headers.get("authorization")).toBe(
      "Bearer boat_fixture_secret"
    )
    const parts = url.pathname.split("/").filter(Boolean).slice(2)
    const body =
      request.method === "GET" || request.method === "DELETE"
        ? {}
        : ((await request.json()) as Record<string, unknown>)
    const response = (data: unknown, status = 200) =>
      Response.json(data, { status })
    if (parts.length === 1 && request.method === "POST") {
      expect(body).toMatchObject({
        type: "small",
        noEnv: true,
        visibility: "private",
        monitoring: false,
      })
      expect(body.ttlSeconds).toBeGreaterThan(0)
      expect(body.ttlSeconds).toBeLessThanOrEqual(1200)
      const key = request.headers.get("idempotency-key")!
      const found = [...boxes].find(([, b]) => b.key === key)
      const id =
        found?.[0] ??
        `bx_${String(++sequence).padStart(8, "2")}`
          .replaceAll("0", "a")
          .replaceAll("1", "b")
      if (!found)
        boxes.set(id, {
          state: "ready",
          key,
          snapshots: body.snapshots === true,
        })
      if (lostCreate) {
        lostCreate = false
        throw new Error("Simulated lost allocation response")
      }
      return response({ sandbox: { id, state: boxes.get(id)!.state } }, 202)
    }
    const id = parts[1],
      box = boxes.get(id)
    if (!box)
      return response({ error: "missing", secret: "boat_fixture_secret" }, 404)
    if (parts.length === 2)
      return response({ sandbox: { id, state: box.state, hydrated: true } })
    if (parts[2] === "stop") {
      const active = await promisify(execFile)(realDocker, [
        "ps",
        "-q",
        "--filter",
        `name=${id}-datool-`,
      ])
      expect(active.stdout.trim()).toBe("")
      box.state = "archived"
      return response({ ok: true }, 202)
    }
    if (parts[2] === "resume") {
      box.state = "ready"
      return response({ ok: true }, 202)
    }
    if (box.state !== "ready")
      return response({ error: "sandbox_not_ready" }, 409)
    if (parts[2] === "files") {
      const path = String(body.path)
      if (!/^\/tmp\/datool-input-[\w-]+\/chunk$/.test(path))
        throw new Error("Unexpected host file path")
      inputs.add(path.slice(0, path.lastIndexOf("/")))
      await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true })
      await writeFile(path, Buffer.from(String(body.content), "base64"))
      return response({ ok: true })
    }
    if (parts[2] === "commands" && parts.length === 3) {
      const command = String(body.command)
      if (failCapture && command.includes("tar -cf")) {
        failCapture = false
        return response({ error: "capture unavailable" }, 503)
      }
      const child = spawn("/bin/sh", ["-c", command], {
        env: {
          ...process.env,
          PATH: `${directory}:${process.env.PATH}`,
          BOAT_TEST_VM: id,
        },
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      const running = {
        child,
        out: Buffer.alloc(0),
        err: Buffer.alloc(0),
        exit: null as number | null,
      }
      child.stdout.on("data", (bytes) => {
        running.out = Buffer.concat([running.out, bytes])
      })
      child.stderr.on("data", (bytes) => {
        running.err = Buffer.concat([running.err, bytes])
      })
      const done = new Promise<void>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code) => {
          running.exit = code ?? 137
          resolve()
        })
      })
      processes.set(child.pid!, running)
      if (body.detached)
        return response({ processId: child.pid, success: true })
      await done
      return response({
        stdout: running.out.toString(),
        stderr: running.err.toString(),
        exitCode: running.exit,
      })
    }
    if (parts[2] === "commands" && parts.length === 4) {
      const entry = processes.get(Number(parts[3]))!
      if (request.method === "DELETE") {
        try {
          process.kill(-entry.child.pid!, "SIGKILL")
        } catch {
          /* Process already exited. */
        }
        return response({ ok: true })
      }
      const offset = Number(url.searchParams.get("stdoutOffset")),
        errorOffset = Number(url.searchParams.get("stderrOffset"))
      return response({
        running: entry.exit === null,
        status: entry.exit === null ? "running" : "exited",
        exitCode: entry.exit,
        stdout: entry.out.subarray(offset).toString(),
        stderr: entry.err.subarray(errorOffset).toString(),
        stdoutOffset: offset,
        stdoutNextOffset: entry.out.length,
        stderrNextOffset: entry.err.length,
        more: false,
      })
    }
    throw new Error(`Unhandled Boat request ${request.method} ${url.pathname}`)
  }
  globalThis.fetch = Object.assign(request, originalFetch)
  return {
    request: globalThis.fetch,
    boxes,
    faults,
    async close() {
      globalThis.fetch = originalFetch
      for (const entry of processes.values())
        if (entry.exit === null) {
          try {
            process.kill(-entry.child.pid!, "SIGKILL")
          } catch {
            /* Process already exited. */
          }
        }
      for (const id of boxes.keys()) {
        const containers = (
          await promisify(execFile)(realDocker, [
            "ps",
            "-aq",
            "--filter",
            `name=${id}-datool-`,
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
        if (containers.length)
          await promisify(execFile)(realDocker, ["rm", "-f", ...containers])
        const volumes = (
          await promisify(execFile)(realDocker, [
            "volume",
            "ls",
            "-q",
            "--filter",
            `name=${id}-datool-`,
          ])
        ).stdout
          .trim()
          .split("\n")
          .filter(Boolean)
        if (volumes.length)
          await promisify(execFile)(realDocker, ["volume", "rm", ...volumes])
      }
      for (const path of inputs)
        await rm(path, { recursive: true, force: true })
      await rm(directory, { recursive: true, force: true })
    },
  }
}
