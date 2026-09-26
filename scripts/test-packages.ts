import { execFileSync } from "node:child_process"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const cwd = await mkdtemp(join(tmpdir(), "datool-package-consumer-"))
try {
  await writeFile(
    join(cwd, "package.json"),
    JSON.stringify({ private: true, type: "module" })
  )
  const tarballs = await Promise.all(
    ["sdk", "cli"].map(async (name) => {
      const manifest = JSON.parse(
        await readFile(join(root, "packages", name, "package.json"), "utf8")
      )
      return join(
        root,
        "artifacts",
        "npm",
        `datool-${name}-${manifest.version}.tgz`
      )
    })
  )
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...tarballs,
      "typescript@5.9.3",
      "@types/node@24",
    ],
    { cwd, stdio: "pipe" }
  )
  await cp(join(root, "tests", "fixtures", "packages"), cwd, {
    recursive: true,
  })
  execFileSync(
    "node",
    [
      "node_modules/typescript/bin/tsc",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "false",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "consumer.ts",
    ],
    { cwd, stdio: "inherit" }
  )
  execFileSync("node", ["consumer.mjs"], { cwd, stdio: "inherit" })
  execFileSync(
    "bun",
    [
      "test",
      join(root, "tests", "cli-connect.test.ts"),
      join(root, "tests", "cli-connect-watch.test.ts"),
    ],
    {
      cwd,
      env: {
        ...process.env,
        DATOOL_TEST_CLI_BINARY: join(
          cwd,
          "node_modules/@datool/cli/dist/datool.js"
        ),
      },
      stdio: "inherit",
    }
  )
  console.info(
    "PASS: packed packages install and run outside the repository, including NodeNext declarations."
  )
} finally {
  await rm(cwd, { recursive: true, force: true })
}
