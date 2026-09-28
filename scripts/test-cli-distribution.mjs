import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises"
import { join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { createServer } from "node:http"

// This test intentionally installs an artifact outside the monorepo. Pass an
// exact npm version after publishing; never let workspace source satisfy it.
const requested = process.argv[2]
assert(requested, "Pass an exact published version or a local .tgz")
const spec = requested.endsWith(".tgz")
  ? resolve(requested)
  : `@datool/cli@${requested}`
if (!requested.endsWith(".tgz")) assert.match(requested, /^\d+\.\d+\.\d+$/)
const execute = promisify(execFile)
const directory = await realpath(
  await mkdtemp(join(tmpdir(), "datool-distribution-"))
)
let count = 0
const server = createServer(async (request, response) => {
  let raw = ""
  for await (const chunk of request) raw += chunk
  const key = request.headers.authorization
  response.setHeader("content-type", "application/json")
  if (request.url === "/api/cli/info") {
    response.end(
      JSON.stringify({
        data: { protocolVersion: 1, minimumCliVersion: "0.2.0" },
      })
    )
    return
  }
  if (!key || key === "Bearer dtk_invalid") {
    response
      .writeHead(401)
      .end(JSON.stringify({ error: { message: "sensitive upstream detail" } }))
    return
  }
  if (
    request.url === "/api/agent/list_traces" &&
    key === "Bearer dtk_writeonly"
  ) {
    response
      .writeHead(403)
      .end(
        JSON.stringify({
          error: {
            message: "sensitive upstream detail",
            details: {
              reason: "INSUFFICIENT_SCOPE",
              missingScopes: ["traces:read"],
            },
          },
        })
      )
    return
  }
  if (
    [
      "/api/agent/start_eval_run",
      "/api/agent/cancel_eval_run",
      "/api/agent/recover_eval_run",
      "/api/agent/get_eval_run",
    ].includes(request.url)
  ) {
    response.end(JSON.stringify({ data: {
      id: "run-fixture",
      status: "cancelled",
      path: request.url,
      input: raw ? JSON.parse(raw) : null,
    } }))
    return
  }
  if (
    ![
      "/api/agent/list_traces",
      "/api/agent/describe_agent_operations",
      "/api/cli/session",
    ].includes(request.url)
  ) {
    response.writeHead(404).end("{}")
    return
  }
  response.end(
    JSON.stringify({
      data: {
        path: request.url,
        project: request.headers["x-project-id"],
        key,
        input: raw ? JSON.parse(raw) : null,
        items: [],
      },
    })
  )
})
try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  await writeFile(
    join(directory, "package.json"),
    '{"private":true,"type":"module"}'
  )
  await execute(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", spec],
    { cwd: directory, timeout: 120000 }
  )
  const binary = join(directory, "node_modules/@datool/cli/dist/datool.js")
  const manifest = JSON.parse(
    await readFile(
      join(directory, "node_modules/@datool/cli/package.json"),
      "utf8"
    )
  )
  if (!requested.endsWith(".tgz")) assert.equal(manifest.version, requested)
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("DATOOL_"))
  )
  const env = { ...inherited, DATOOL_CONFIG_DIR: join(directory, "config") }
  await mkdir(join(directory, "src/deep"), { recursive: true })
  await writeFile(
    join(directory, ".env"),
    `DATOOL_BASE_URL=${origin}\nDATOOL_PROJECT_ID=base\nDATOOL_API_KEY=dtk_base\n`
  )
  await writeFile(
    join(directory, ".env.local"),
    "DATOOL_PROJECT_ID=local\nDATOOL_API_KEY=dtk_local\n"
  )
  await writeFile(
    join(directory, "custom.env"),
    `DATOOL_BASE_URL=${origin}\nDATOOL_PROJECT_ID=custom\nDATOOL_API_KEY=dtk_custom\n`
  )
  const runtimes =
    process.env.DATOOL_TEST_NODE_ONLY === "1" ? ["node"] : ["node", "bun"]
  for (const runtime of runtimes) {
    async function run(args, options = {}) {
      let result
      try {
        result = {
          ...(await execute(
            runtime,
            [...(runtime === "bun" ? ["--no-env-file"] : []), binary, ...args],
            {
              cwd: options.cwd ?? directory,
              env: { ...env, ...options.env },
              timeout: 20000,
            }
          )),
          code: 0,
        }
      } catch (error) {
        result = {
          stdout: error.stdout,
          stderr: error.stderr,
          code: error.code,
        }
      }
      assert.equal(
        result.code,
        options.exit ?? 0,
        `${runtime} ${args.slice(0, 2).join(" ")}: unexpected exit ${result.code}`
      )
      assert(!result.stderr.includes("sensitive upstream detail"))
      count++
      return result
    }
    assert.equal((await run(["--version"])).stdout.trim(), manifest.version)
    const tools = JSON.parse((await run(["agent", "tools"])).stdout)
    assert.equal(tools.path, "/api/agent/describe_agent_operations")
    // The skills still support 0.3.0 through generic calls. Keep the newer
    // alias checks for every other release and local tarball.
    if (manifest.version === "0.3.0") {
      const inputs = [
        [
          "start_eval_run",
          { parentRunId: "parent-fixture", useRecordedVersions: true },
        ],
        ["cancel_eval_run", { id: "run-fixture" }],
        ["recover_eval_run", { id: "run-fixture" }],
      ]
      for (const [operation, input] of inputs) {
        const result = JSON.parse(
          (
            await run([
              "agent",
              "call",
              operation,
              "--input",
              JSON.stringify(input),
            ])
          ).stdout
        )
        assert.equal(result.path, `/api/agent/${operation}`)
        assert.deepEqual(result.input, input)
      }
    } else {
      const iteration = JSON.parse(
        (
          await run([
            "evals",
            "run",
            "--parent-run-id",
            "parent-fixture",
            "--use-recorded-versions",
          ])
        ).stdout
      )
      assert.equal(iteration.path, "/api/agent/start_eval_run")
      assert.deepEqual(iteration.input, {
        parentRunId: "parent-fixture",
        useRecordedVersions: true,
      })
      const cancelled = JSON.parse(
        (await run(["evals", "cancel", "run-fixture"])).stdout
      )
      assert.equal(cancelled.path, "/api/agent/cancel_eval_run")
      assert.deepEqual(cancelled.input, { id: "run-fixture" })
      const recovered = JSON.parse(
        (await run(["evals", "recover", "run-fixture"])).stdout
      )
      assert.equal(recovered.path, "/api/agent/recover_eval_run")
      assert.deepEqual(recovered.input, { id: "run-fixture" })
      const waited = JSON.parse(
        (await run(["evals", "recover", "run-fixture", "--wait"])).stdout
      )
      assert.equal(waited.path, "/api/agent/get_eval_run")
      assert.equal(waited.status, "cancelled")
    }
    for (const cwd of [directory, join(directory, "src/deep")]) {
      const automatic = JSON.parse(
        (await run(["traces", "list", "--limit", "1"], { cwd })).stdout
      )
      assert.equal(automatic.project, "local")
      assert.equal(automatic.key, "Bearer dtk_local")
      assert.deepEqual(automatic.input, { limit: 1 })
      const shell = JSON.parse(
        (
          await run(["traces", "list"], {
            cwd,
            env: { DATOOL_PROJECT_ID: "base", DATOOL_API_KEY: "dtk_shell" },
          })
        ).stdout
      )
      assert.equal(shell.project, "base")
      assert.equal(shell.key, "Bearer dtk_shell")
      const flags = JSON.parse(
        (
          await run(
            [
              "--project",
              "flag",
              "traces",
              "list",
              "--env-file",
              join(directory, "custom.env"),
            ],
            { cwd }
          )
        ).stdout
      )
      assert.equal(flags.project, "flag")
      assert.equal(flags.key, "Bearer dtk_custom")
      await run(["traces", "list", "--no-env"], { cwd, exit: 1 })
      await run(["traces", "list"], {
        cwd,
        env: { DATOOL_NO_ENV: "1" },
        exit: 1,
      })
      const disabled = JSON.parse(
        (
          await run(["traces", "list", "--no-env"], {
            cwd,
            env: {
              DATOOL_BASE_URL: origin,
              DATOOL_PROJECT_ID: "shell",
              DATOOL_API_KEY: "dtk_shell",
            },
          })
        ).stdout
      )
      assert.equal(disabled.project, "shell")
    }
    const healthy = JSON.parse((await run(["doctor", "--json"])).stdout)
    assert.equal(healthy.ok, true)
    assert.equal(healthy.project, "local")
    assert.equal(
      healthy.configuration.sources.project,
      join(directory, ".env.local")
    )
    assert(!JSON.stringify(healthy).includes("dtk_local"))
    const denied = JSON.parse(
      (
        await run(["doctor", "--json"], {
          env: { DATOOL_API_KEY: "dtk_writeonly" },
          exit: 1,
        })
      ).stdout
    )
    assert.equal(
      denied.checks.find((check) => check.name === "authentication").ok,
      true
    )
    assert.deepEqual(
      denied.checks.find((check) => check.name === "trace-read").missingScopes,
      ["traces:read"]
    )
    const invalid = JSON.parse(
      (
        await run(["doctor", "--json"], {
          env: { DATOOL_API_KEY: "dtk_invalid" },
          exit: 1,
        })
      ).stdout
    )
    assert.equal(
      invalid.checks.find((check) => check.name === "authentication").status,
      401
    )
  }
  console.info(
    `PASS ${count} distribution checks: ${spec}, installed ${manifest.version}, ${runtimes.join(" + ")}`
  )
} finally {
  server.closeAllConnections()
  await new Promise((resolve) => server.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
