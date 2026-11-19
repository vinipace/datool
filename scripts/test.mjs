import { spawnSync } from "node:child_process"

// Run browser-backed evaluations on Node, the supported Playwright runtime.
// Keep that driver separate from Bun's test-file lifecycle and provider mocks.
const args = process.argv.slice(2)
const journeysOnly = args.includes("--journeys-only")
const forwarded = args.filter((arg) => arg !== "--journeys-only")
const batches = [
  ...(!journeysOnly
    ? [
        {
          command: process.versions.bun ? process.execPath : "bun",
          args: ["--no-env-file", "test", "tests", ...forwarded],
        },
      ]
    : []),
  {
    command: "node",
    args: [
      "node_modules/vitest/vitest.mjs",
      "run",
      "--config",
      "vitest.agent-journeys.config.mts",
    ],
  },
]
let failed = false
for (const batch of batches) {
  const result = spawnSync(batch.command, batch.args, { stdio: "inherit" })
  if (result.error) console.error(result.error.message)
  if (result.status !== 0) failed = true
}
process.exitCode = failed ? 1 : 0
