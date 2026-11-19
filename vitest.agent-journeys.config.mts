import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  envDir: false,
  resolve: {
    alias: { "@": path.dirname(fileURLToPath(import.meta.url)) },
  },
  test: {
    name: "agent-journeys",
    environment: "node",
    include: ["tests/agent-journey-*.integration.ts"],
    pool: "forks",
    fileParallelism: false,
    isolate: true,
    testTimeout: 120_000,
  },
})
