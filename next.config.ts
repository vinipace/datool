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
  serverExternalPackages: ["autoevals", "esbuild"],
  outputFileTracingIncludes: {
    "/api/mcp/trace-explorer": ["./public/mcp-apps/trace-explorer.html"],
    "/api/**": [
      "./src/server/build/knowledge/document-worker.mjs",
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
  // This installation uses Payload's PostgreSQL adapter. Its unconditional
  // SQLite include is unnecessary, and recursively searching Bun's linked
  // dependency tree for it can exhaust the build's tracing heap.
  for (const [route, patterns] of Object.entries(config.outputFileTracingIncludes ?? {})) {
    config.outputFileTracingIncludes![route] = patterns.filter((pattern) => pattern !== "@libsql/client")
  }
  return config
}
