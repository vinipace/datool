import assert from "node:assert/strict"

// Read-only probes: never create an OAuth client, issue credentials, or execute
// a project operation. Safe to rerun against a preview or a released public host.
const base = process.env.AGENT_READINESS_URL
assert(base, "Set AGENT_READINESS_URL to the running preview or public origin.")
let checks = 0
async function request(
  path: string,
  accept = "application/json",
  method = "GET"
) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: { Accept: accept },
    redirect: "follow",
  })
  const body = await response.text()
  checks++
  return { response, body }
}
function varyAccept(response: Response) {
  assert.ok(
    response.headers
      .get("vary")
      ?.toLowerCase()
      .split(/,\s*/)
      .includes("accept"),
    `${response.url}: missing Vary: Accept`
  )
}
function markdown(response: Response, body: string, status = 200) {
  assert.equal(response.status, status, response.url)
  assert.match(response.headers.get("content-type") ?? "", /^text\/markdown\b/)
  assert.match(body, /^# /m)
  assert.ok(body.length > 20)
  assert.doesNotMatch(body, /<!doctype html>/i)
}

const home = await request("/", "text/markdown")
markdown(home.response, home.body)
varyAccept(home.response)
assert.match(home.body, /Datool/)
for (const accept of [
  "text/html",
  "*/*",
  "text/markdown;q=0, text/html",
  "text/markdown;q=0.2, text/html;q=0.8",
]) {
  const { response, body } = await request("/", accept)
  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/)
  assert.match(body, /<!doctype html>/i)
  // Next's HTML renderer owns Vary; the dynamic homepage must not be cached.
  assert.match(response.headers.get("cache-control") ?? "", /no-store|no-cache/)
}
for (const path of ["/", "/landing-page", "/product/build", "/faq"]) {
  const { response, body } = await request(path, "text/markdown")
  markdown(response, body)
  varyAccept(response)
  const head = await request(path, "text/markdown", "HEAD")
  assert.equal(head.response.status, 200)
  assert.equal(head.body, "")
  assert.equal(
    head.response.headers.get("content-type"),
    response.headers.get("content-type")
  )
}
for (const path of [
  "/__agent-readiness-missing",
  "/missing-agent-page/nested",
  "/pages/missing-agent-page",
  "/product/missing-agent-page",
  "/faq/missing-agent-question",
  "/docs/markdown/missing-agent-page",
]) {
  const { response, body } = await request(path, "text/markdown")
  markdown(response, body, 404)
  varyAccept(response)
  assert.match(body, /\[[^\]]+\]\(\/(?:docs|llms\.txt|sitemap\.xml)\)/)
  const head = await request(path, "text/markdown", "HEAD")
  assert.equal(head.response.status, 404)
  assert.equal(head.body, "")
}
const browser404 = await request("/__agent-readiness-missing", "text/html")
assert.equal(browser404.response.status, 404)
assert.match(
  browser404.response.headers.get("content-type") ?? "",
  /^text\/html\b/
)
assert.match(browser404.body, /<!doctype html>/i)

for (const path of [
  "/api",
  "/api/__agent-readiness-missing",
  "/api/unknown/nested",
]) {
  for (const method of [
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "HEAD",
  ]) {
    const { response, body } = await request(path, "text/html", method)
    assert.equal(response.status, 404, `${method} ${path}`)
    assert.match(
      response.headers.get("content-type") ?? "",
      /^application\/json\b/
    )
    if (method === "HEAD") {
      assert.equal(body, "")
      continue
    }
    const error = JSON.parse(body).error
    assert.equal(error.code, "NOT_FOUND")
    assert.ok(error.message.length > 10)
    assert.match(error.hint, /openapi\.json/)
  }
}

const specResponse = await request("/openapi.json")
assert.equal(specResponse.response.status, 200)
assert.match(
  specResponse.response.headers.get("content-type") ?? "",
  /^application\/json\b/
)
const spec = JSON.parse(specResponse.body)
assert.equal(spec.openapi, "3.1.1")
assert.ok(Object.keys(spec.paths).length > 0)
assert.equal(
  (await request("/openapi.json", "application/json", "HEAD")).body,
  ""
)
for (const path of Object.keys(spec.paths)) {
  // Missing project is rejected before authentication or business logic.
  const { response, body } = await request(path, "application/json", "POST")
  assert.equal(response.status, 400, path)
  const error = JSON.parse(body).error
  assert.equal(error.code, "VALIDATION_ERROR", path)
  assert.match(error.message, /project ID/i)
  assert.match(error.hint, /x-project-id/)
}

const metadataResponse = await request(
  "/.well-known/oauth-authorization-server"
)
assert.equal(metadataResponse.response.status, 200)
const metadata = JSON.parse(metadataResponse.body)
assert.equal(metadata.issuer, `${spec.servers[0].url}/api/auth`)
assert.ok(metadata.response_types_supported.includes("code"))
assert.ok(metadata.code_challenge_methods_supported.includes("S256"))
assert.deepEqual(metadata.grant_types_supported.sort(), [
  "authorization_code",
  "refresh_token",
])
const issuer = new URL(metadata.issuer)
const canonicalDiscovery = await request(
  `/.well-known/oauth-authorization-server${issuer.pathname}`
)
assert.equal(canonicalDiscovery.response.status, 200)
assert.deepEqual(JSON.parse(canonicalDiscovery.body), metadata)
const protectedResource = await request(
  "/.well-known/oauth-protected-resource/api/mcp"
)
assert.equal(protectedResource.response.status, 200)
assert.deepEqual(JSON.parse(protectedResource.body).authorization_servers, [
  metadata.issuer,
])
const oidc = await request("/.well-known/openid-configuration/api/auth")
assert.equal(oidc.response.status, 200)
assert.equal(JSON.parse(oidc.body).issuer, metadata.issuer)
const jwks = await request(new URL(metadata.jwks_uri).pathname)
assert.equal(jwks.response.status, 200)
assert.ok(Array.isArray(JSON.parse(jwks.body).keys))
for (const field of ["token_endpoint", "registration_endpoint"]) {
  const response: Response = await fetch(
    new URL(new URL(metadata[field]).pathname, base),
    {
      method: "POST",
      headers: {
        "Content-Type":
          field === "token_endpoint"
            ? "application/x-www-form-urlencoded"
            : "application/json",
      },
      body: field === "token_endpoint" ? "grant_type=unsupported_probe" : "{}",
    }
  )
  checks++
  const body: string = await response.text()
  assert.ok(response.status >= 400 && response.status < 500, field)
  assert.match(
    response.headers.get("content-type") ?? "",
    /^application\/json\b/
  )
  assert.equal(typeof JSON.parse(body).error, "string")
}
const llms = await request("/llms.txt", "text/plain")
assert.equal(llms.response.status, 200)
assert.match(llms.body, /\/openapi\.json/)
assert.match(llms.body, /\/\.well-known\/oauth-authorization-server/)
for (const match of llms.body.matchAll(
  /\]\((https?:\/\/[^)]+\/docs(?:\/[^)]*)?\.md)\)/g
)) {
  const path = new URL(match[1]).pathname
  const doc = await request(path, "text/markdown")
  markdown(doc.response, doc.body)
}
const sitemap = await request("/sitemap.xml", "application/xml")
assert.equal(sitemap.response.status, 200)
assert.match(sitemap.body, /<urlset\b/)
console.log(
  `PASS ${checks} public HTTP probes; ${Object.keys(spec.paths).length} agent routes; Markdown/HTML/HEAD, 404s, JSON errors, OpenAPI, OAuth/OIDC, JWKS, llms.txt and sitemap.`
)
