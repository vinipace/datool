import { docsMarkdownUrl, docsSource } from "@/lib/docs-source"
import { docsOrigin } from "@/lib/docs-origin"

export const dynamic = "force-dynamic"

export function GET(request: Request) {
  const origin = docsOrigin(request)
  const pages = docsSource.getPages().sort((a, b) => a.url.localeCompare(b.url))
  const links = pages.map(
    (page) =>
      `- [${page.data.title}](${origin}${docsMarkdownUrl(page.slugs)}): ${page.data.description ?? ""}`
  )
  return new Response(
    [
      "# Datool",
      "",
      "> Trace AI applications, inspect their behavior, and evaluate their outputs.",
      "",
      "These are the public product docs. Each link returns Markdown. Credentials and project access are required for product API operations, but not for these docs.",
      "",
      "## Documentation",
      "",
      ...links,
      "",
      "## API discovery",
      "",
      `- [OpenAPI specification](${origin}/openapi.json): Agent operations, request schemas, required scopes, and errors.`,
      `- [OAuth authorization server](${origin}/.well-known/oauth-authorization-server): Authorization code with PKCE and refresh tokens.`,
      `- [MCP protected resource](${origin}/.well-known/oauth-protected-resource/api/mcp): MCP authentication and scopes.`,
      "",
    ].join("\n"),
    { headers: { "Content-Type": "text/plain; charset=utf-8" } }
  )
}
