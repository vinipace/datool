import type { StorybookConfig } from "@storybook/nextjs-vite"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)

const config: StorybookConfig = {
  stories: [
    "../components/**/*.stories.@(js|jsx|mjs|ts|tsx)",
    "../app/**/*.stories.@(js|jsx|mjs|ts|tsx)",
  ],
  addons: [
    "@storybook/addon-vitest",
    "@storybook/addon-a11y",
    "@storybook/addon-docs",
    "@storybook/addon-themes",
    "msw-storybook-addon",
  ],
  framework: "@storybook/nextjs-vite",
  core: { disableTelemetry: true },
  staticDirs: ["../public", "./public"],
  viteFinal(config) {
    const aliases = config.resolve?.alias ?? {}
    config.resolve = {
      ...config.resolve,
      alias: {
        ...aliases,
        // Use the same React runtime as Next for Payload's compiled UI.
        "react/compiler-runtime": require.resolve("next/dist/compiled/react/compiler-runtime"),
      },
    }
    return config
  },
}

export default config
