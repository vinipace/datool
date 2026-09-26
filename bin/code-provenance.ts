import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync, statSync } from "node:fs"
import { resolve } from "node:path"

/** Best-effort source identity, not a deployment attestation or a copy of application code. */
export function captureCodeProvenance(cwd = process.cwd()) {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      maxBuffer: 32 * 1024 * 1024,
    })
  try {
    const root = git(["rev-parse", "--show-toplevel"]).trim()
    const revision = git(["rev-parse", "HEAD"]).trim()
    const status = git(["status", "--porcelain", "-z"])
    const hash = createHash("sha256")
      .update(revision)
      .update(git(["diff", "HEAD", "--binary"]))
    const files = git(["ls-files", "--others", "--exclude-standard", "-z"])
      .split("\0")
      .filter(Boolean)
      .sort()
    let bytes = 0
    for (const file of files) {
      const path = resolve(root, file)
      bytes += statSync(path).size
      if (bytes > 32 * 1024 * 1024) return { source: "unknown" as const }
      hash.update(file).update(readFileSync(path))
    }
    return {
      source: "local-git" as const,
      revision,
      dirty: status.length > 0,
      fingerprint: hash.digest("hex"),
    }
  } catch {
    return { source: "unknown" as const }
  }
}
