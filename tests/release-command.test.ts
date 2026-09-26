import { afterEach, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../", import.meta.url))
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true })
})

function release(failCommand = "", cms = "true") {
  const directory = mkdtempSync(join(tmpdir(), "datool-release-test-"))
  directories.push(directory)
  const log = join(directory, "commands.log")
  writeFileSync(
    join(directory, "bun"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$RELEASE_TEST_LOG"\n[ "$*" != "$RELEASE_TEST_FAIL" ] || exit 7\n',
    { mode: 0o755 }
  )
  // Match Dokku's direct process invocation; do not interpret shell operators.
  const command = readFileSync(join(root, "Procfile"), "utf8")
    .split("\n")
    .find((line) => line.startsWith("release: "))!
    .slice("release: ".length)
    .split(/\s+/)
  const result = spawnSync(command[0], command.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH}`,
      DATOOL_CMS_ENABLED: cms,
      PAYLOAD_SECRET: "test-only-payload-secret-at-least-thirty-two-characters",
      RELEASE_TEST_LOG: log,
      RELEASE_TEST_FAIL: failCommand,
    },
  })
  return { result, commands: readFileSync(log, "utf8").trim().split("\n") }
}

test("the Procfile release process runs both application and CMS migrations", () => {
  const { result, commands } = release()
  expect(result.status).toBe(0)
  expect(commands).toEqual(["run db:migrate", "run cms:migrate"])
})

test("failed application migrations stop the release before CMS migrations", () => {
  const { result, commands } = release("run db:migrate")
  expect(result.status).toBe(7)
  expect(commands).toEqual(["run db:migrate"])
})

test("failed CMS migrations fail the release", () => {
  const { result, commands } = release("run cms:migrate")
  expect(result.status).toBe(7)
  expect(commands).toEqual(["run db:migrate", "run cms:migrate"])
})

for (const cms of ["", "false"]) {
  test(`CMS migrations are skipped when disabled (${cms || "unset"})`, () => {
    const { result, commands } = release("", cms)
    expect(result.status).toBe(0)
    expect(commands).toEqual(["run db:migrate"])
  })
}
