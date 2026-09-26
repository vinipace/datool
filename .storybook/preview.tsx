import type { Preview } from "@storybook/nextjs-vite"
import { withThemeByClassName } from "@storybook/addon-themes"
import { setupWorker } from "msw/browser"
import { mswLoader } from "msw-storybook-addon/csf3"
import { themes } from "storybook/theming"
import { mocked, sb } from "storybook/test"
import { navigateWorkspace, useOrganizationSessionSync } from "../lib/workspace-selection"

sb.mock("../lib/workspace-selection.ts", { spy: true })

import "../app/globals.css"
import "./preview.css"
import { StorybookProviders } from "./storybook-providers"

const preview: Preview = {
  beforeEach: () => {
    // Session lifecycle and document navigation are covered by the real-app browser suite.
    mocked(navigateWorkspace).mockImplementation(() => {})
    mocked(useOrganizationSessionSync).mockImplementation(() => {})
  },
  initialGlobals: { theme: "dark" },
  decorators: [
    (Story, context) => (
      <StorybookProviders key={context.id}>
        <Story />
      </StorybookProviders>
    ),
    withThemeByClassName({
      themes: { light: "light", dark: "dark" },
      defaultTheme: "dark",
    }),
  ],
  loaders: [
    mswLoader(async () => {
      const worker = setupWorker()
      await worker.start({
        quiet: true,
        onUnhandledRequest(request, print) {
          const url = new URL(request.url)
          // Vite and local assets can pass through. Missing API handlers and
          // external HTTP requests must fail instead of reaching live services.
          if (
            url.pathname.startsWith("/api/") ||
            url.origin !== location.origin
          ) {
            print.error()
          }
        },
      })
      return worker
    }),
  ],
  tags: ["autodocs"],
  parameters: {
    // Percentage-sized editors and charts need an established parent width.
    layout: "padded",
    backgrounds: { disable: true },
    themes: { themeOverride: "dark" },
    docs: {
      theme: {
        ...themes.dark,
        appContentBg: "var(--background)",
        appPreviewBg: "var(--background)",
      },
    },
    nextjs: {
      appDirectory: true,
      navigation: { pathname: "/storybook", query: {} },
    },
    controls: {
      expanded: true,
      matchers: { color: /(background|color)$/i, date: /Date$/i },
    },
    a11y: { test: "error" },
  },
}

export default preview
