import { afterEach, expect, test } from "bun:test"
import { execFileSync, spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const source = fileURLToPath(new URL("..", import.meta.url))
const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "datool-git-hooks-"))
  temporary.push(directory)
  const root = join(directory, "checkout")
  mkdirSync(root)
  // Git exports its repository/config environment to hooks. A nested fixture
  // must never inherit it, or its git commands would target the pushing repo.
  const inherited: NodeJS.ProcessEnv = { ...process.env }
  for (const key of Object.keys(inherited)) {
    if (key.startsWith("GIT_")) delete inherited[key]
  }
  const env: NodeJS.ProcessEnv = { ...inherited, CI: "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-q", "--initial-branch=main")
  git("config", "user.name", "Hook fixture")
  git("config", "user.email", "hook@example.test")
  for (const path of ["scripts/install-git-hooks.mjs", ".githooks/pre-push"]) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    copyFileSync(join(source, path), join(root, path))
  }
  const install = (extra = {}) => spawnSync("node", ["scripts/install-git-hooks.mjs"], { cwd: root, env: { ...env, ...extra }, encoding: "utf8" })
  return { directory, root, env, git, install }
}

test("installed hook rejects a real push on check failure and allows it after success", () => {
  const { directory, root, env, git, install } = fixture()
  const remote = join(directory, "remote.git")
  git("init", "--bare", "-q", remote)
  git("remote", "add", "origin", remote)
  git("add", ".")
  git("commit", "-qm", "Fixture")
  expect(install().status).toBe(0)
  expect(install().status).toBe(0)

  const bin = join(directory, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "bun"), '#!/bin/sh\nprintf "%s\\n" "$*" > "$DATOOL_HOOK_TEST_LOG"\nexit "${DATOOL_HOOK_TEST_EXIT:-0}"\n', { mode: 0o755 })
  const log = join(directory, "check.log")
  const push = (code: string) => spawnSync("git", ["push", "origin", "main"], {
    cwd: root,
    env: { ...env, PATH: `${bin}:${env.PATH}`, DATOOL_HOOK_TEST_LOG: log, DATOOL_HOOK_TEST_EXIT: code },
    encoding: "utf8",
  })
  expect(push("1").status).not.toBe(0)
  expect(readFileSync(log, "utf8").trim()).toBe("run check:pre-push")
  expect(git("ls-remote", "origin", "refs/heads/main")).toBe("")
  expect(push("0").status).toBe(0)
  expect(git("ls-remote", "origin", "refs/heads/main")).toContain(git("rev-parse", "HEAD"))
})

test("installer preserves an existing hook, including a custom hooks directory", () => {
  const { root, git, install } = fixture()
  for (const directory of [".git/hooks", ".custom-hooks"]) {
    git("config", "core.hooksPath", directory)
    mkdirSync(join(root, directory), { recursive: true })
    const path = join(root, directory, "pre-push")
    const original = "#!/bin/sh\necho existing-check\n"
    writeFileSync(path, original, { mode: 0o755 })
    const result = install()
    expect(result.status).toBe(0)
    expect(result.stderr).toContain("Keeping existing pre-push hook")
    expect(readFileSync(path, "utf8")).toBe(original)
  }
})

test("installer skips CI and source archives without Git metadata", () => {
  const { root, install } = fixture()
  expect(install({ CI: "true" }).status).toBe(0)
  expect(existsSync(join(root, ".git/hooks/pre-push"))).toBe(false)
  rmSync(join(root, ".git"), { recursive: true })
  expect(install().status).toBe(0)
  expect(existsSync(join(root, ".git"))).toBe(false)
})

test("shared hook resolves the checkout being pushed, including linked worktrees", () => {
  const { directory, root, env, git, install } = fixture()
  git("add", ".")
  git("commit", "-qm", "Fixture")
  const linked = join(directory, "linked")
  git("worktree", "add", "-q", "-b", "linked", linked)
  expect(install().status).toBe(0)
  writeFileSync(join(linked, ".githooks/pre-push"), "#!/bin/sh\nexit 42\n")
  const hook = join(root, ".git/hooks/pre-push")
  expect(spawnSync(hook, [], { cwd: linked, env }).status).toBe(42)
  rmSync(join(linked, ".githooks/pre-push"))
  expect(spawnSync(hook, [], { cwd: linked, env }).status).toBe(0)
})
