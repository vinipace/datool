import type { NextConfig } from "next"
import { PHASE_PRODUCTION_SERVER } from "next/constants"
import { createMDX } from "fumadocs-mdx/next"
import { withPayload } from "@payloadcms/next/withPayload"

const nextConfig: NextConfig = {
  // Keep the development overlay from covering product header actions.
  devIndicators: false,
  async headers() {
    return [
      {
        source: "/cms/:path*",
        headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }],
      },
    ]
  },
  redirects() {
    return [{ source: "/app/:path*", destination: "/:path*", permanent: false }]
  },
  rewrites() {
    return {
      afterFiles: [
        {
          source: "/landing-page.md",
          destination: "/api/cms-markdown/landing-page",
        },
        {
          source: "/pages/:slug.md",
          destination: "/api/cms-markdown/pages/:slug",
        },
        { source: "/faq.md", destination: "/api/cms-markdown/faq" },
        {
          source: "/product/:slug.md",
          destination: "/api/cms-markdown/product/:slug",
        },
        { source: "/faq/:slug.md", destination: "/api/cms-markdown/faq/:slug" },
      ],
      fallback: [
        {
          source: "/:path*",
          has: [
            { type: "header" as const, key: "x-datool-markdown", value: "1" },
          ],
          destination: "/api/markdown-not-found",
        },
      ],
    }
  },
  ...(process.env.DATOOL_DIST_DIR
    ? { distDir: process.env.DATOOL_DIST_DIR }
    : {}),
  serverExternalPackages: ["autoevals"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./src/server/sandbox/evaluator-worker.mjs",
      "./src/server/sandbox/python-evaluator-worker.py",
      "./src/server/sandbox/library-evaluator-worker.mjs",
      "./node_modules/autoevals/package.json",
    ],
  },
}

// Content is compiled at build time; production startup needs no source files.
export default (phase: string) => {
  const config = withPayload(
    phase === PHASE_PRODUCTION_SERVER ? nextConfig : createMDX()(nextConfig)
  )
  // Payload's bare package include can match Bun directory symlinks. Next 16.3
  // hashes includes as files; trace package contents instead (Next.js #96626).
  for (const [route, patterns] of Object.entries(config.outputFileTracingIncludes ?? {})) {
    config.outputFileTracingIncludes![route] = patterns.map((pattern) =>
      pattern === "@libsql/client" ? "./node_modules/**/@libsql/client/**/*.*" : pattern
    )
  }
  return config
}
