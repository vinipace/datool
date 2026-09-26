import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const marker = "# datool-managed-pre-push"

// CI and production images do not push code or install workstation hooks.
if (!process.env.CI && existsSync(join(root, ".git"))) {
  const result = spawnSync("git", ["rev-parse", "--git-path", "hooks/pre-push"], {
    cwd: root,
    encoding: "utf8",
  })
  if (result.status !== 0) {
    throw new Error(`Cannot locate Git hooks: ${result.stderr || result.error}`)
  }
  const hook = resolve(root, result.stdout.trim())
  if (existsSync(hook) && !readFileSync(hook, "utf8").includes(marker)) {
    console.warn(
      `Keeping existing pre-push hook at ${hook}. Add bun run check:pre-push to that hook to enable Datool checks.`
    )
  } else {
    mkdirSync(dirname(hook), { recursive: true })
    writeFileSync(
      hook,
      `#!/bin/sh
${marker}
set -eu
root=$(git rev-parse --show-toplevel)
# Linked worktrees share hooks; older branches may not yet have these checks.
if [ -f "$root/.githooks/pre-push" ]; then
  exec sh "$root/.githooks/pre-push" "$@"
fi
`,
      { mode: 0o755 }
    )
    chmodSync(hook, 0o755)
    console.log("Installed Datool pre-push checks.")
  }
}
