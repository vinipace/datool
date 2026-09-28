import path from "node:path"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { storybookTest } from "@storybook/addon-vitest/vitest-plugin"
import { playwright } from "@vitest/browser-playwright"
import { defineConfig } from "vitest/config"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        optimizeDeps: { include: ["@tiptap/react/menus", "storybook/theming", "prettier/standalone", "prettier/plugins/babel", "prettier/plugins/estree"] },
        plugins: [
          storybookTest({ configDir: path.join(dirname, ".storybook") }),
        ],
        test: {
          name: "storybook",
          alias: {
            // Payload UI uses React Compiler; keep this subpath ahead of
            // the Next plugin's broad React alias in Vitest.
            "react/compiler-runtime": require.resolve("next/dist/compiled/react/compiler-runtime"),
          },
          browser: {
            enabled: true,
            headless: true,
            fileParallelism: false,
            api: {
              host: "127.0.0.1",
              port: Number(process.env.STORYBOOK_TEST_PORT || 63315),
            },
            provider: playwright({}),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
  },
})
