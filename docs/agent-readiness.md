# Public agent discovery

Datool publishes `/openapi.json` from the same operation catalog, input schemas,
and scopes used by the agent REST endpoint, MCP, and CLI. The document describes
the supported `POST /api/agent/{operation}` surface. It does not claim to describe
browser-internal endpoints or the MCP JSON-RPC transport. Result values vary by
operation; request schemas and the shared error envelope are machine-readable.

Anonymous clients can request Markdown on `/`, `/landing-page`, `/pages/{slug}`,
`/product/{slug}`, and `/faq` pages. These representations use published CMS
reads, ignoring preview/draft query parameters. Explicit `.md` aliases remain
available. Docs support the same Accept negotiation and `.md` URLs listed in `/llms.txt`.
HTML rendering and workspace authentication are unchanged.

Negotiation honors Accept quality values and excludes `q=0`; explicit HTML wins
a tie. Markdown responses include `Content-Type: text/markdown` and `Vary: Accept`.
Next 16.3 owns the HTML renderer's Vary header; the dynamic homepage uses
`no-store` in production (and `no-cache` in development), preventing reuse of an
HTML response for a Markdown request.

Unmatched public paths requesting Markdown return a Markdown 404 after normal
route resolution. Unknown API paths return JSON 404 for all supported HTTP
methods. Shared REST errors retain their status, code, message, details, and
Retry-After values, with an additive resolution hint. OAuth and MCP keep their
protocol-specific errors.

## OAuth discovery

OAuth authorization code with PKCE S256 and refresh tokens already exists.
On 2026-09-23, both `https://trydatool.com/.well-known/oauth-authorization-server`
and its `/api/auth` variant returned HTTP 200 JSON, advertising the canonical
issuer `https://www.trydatool.com/api/auth`. The audit's missing-OAuth finding
was not reproducible. No new provider, credentials, or consent flow is required.

For that issuer, RFC 8414 discovery is at
`/.well-known/oauth-authorization-server/api/auth`. The root route remains a
discovery alias. REST tokens use the `/api/cli` resource audience; MCP tokens use
`/api/mcp`. `/llms.txt` links to the existing OAuth metadata and protected-resource
metadata as well as OpenAPI.

## Verification

Run the contract tests and the HTTP suite against a seeded local preview or a
released host:

```sh
bun test tests/agent-readiness.test.ts tests/docs-content.test.ts tests/project-api-response.test.ts
AGENT_READINESS_URL=http://127.0.0.1:3000 bun run test:agents:http
```

The HTTP suite follows redirects and checks final status, media type, and body.
It checks every advertised agent route with a missing project header, before
business logic can run, plus every Markdown documentation URL in `llms.txt`.
OAuth probes use invalid input and never register a client or issue credentials.

After release, run the suite against `https://trydatool.com`, then rerun the
external audit. Local checks do not establish a new readiness score or prove
that the PR has been deployed.

Protocol references: [HTTP Accept and Vary](https://www.rfc-editor.org/rfc/rfc9110.html),
[OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html), and
[OAuth authorization server metadata](https://www.rfc-editor.org/rfc/rfc8414.html).
