import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { chromium } from "playwright"
import { createTracer } from "../src/lib/tracer/sdk"

const origin = process.env.DATOOL_TEST_ORIGIN!
const directory = process.env.DATOOL_TEST_DIRECTORY!
const evidence = process.env.DATOOL_TEST_EVIDENCE!
const phase = process.argv[2]
assert(
  origin.startsWith("https://localhost:"),
  "Only disposable loopback installations may be tested"
)
const stateFile = join(directory, "state.json")
// Only this disposable browser trusts the fixture self-signed certificate,
// including contexts restored from persisted sessions after container recreation.
const browser = await chromium.launch({
  headless: true,
  args: ["--ignore-certificate-errors"],
})
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 1000 },
  ...(phase !== "bootstrap"
    ? { storageState: join(directory, "session.json") }
    : {}),
})
const page = await context.newPage()
page.setDefaultTimeout(30_000)
const pageErrors: string[] = []
page.on("pageerror", (error) => pageErrors.push(error.message))
async function call(path: string, data?: unknown) {
  const response = await context.request.fetch(`${origin}${path}`, {
    method: data === undefined ? "GET" : "POST",
    ...(data === undefined ? {} : { data }),
    headers: { origin },
  })
  assert(
    response.ok(),
    `${path}: HTTP ${response.status()} ${await response.text()}`
  )
  return response.json()
}
type State = {
  organizationId: string
  projectId: string
  apiKey: string
  traceId: string
  evaluatorIds: string[]
  runIds: string[]
}
const state: State =
  phase === "bootstrap"
    ? {
        organizationId: "",
        projectId: "",
        apiKey: "",
        traceId: "",
        evaluatorIds: [],
        runIds: [],
      }
    : JSON.parse(readFileSync(stateFile, "utf8"))
async function api(path: string, data?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: data === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${state.apiKey}`,
      "x-project-id": state.projectId,
      "content-type": "application/json",
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  })
  assert(
    response.ok,
    `${path}: HTTP ${response.status}: ${await response.clone().text()}`
  )
  return (await response.json()).data
}
async function waitForRun(id: string) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const run = await api(`/api/evals/${id}`)
    if (run.status !== "running" && run.status !== "queued") return run
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error("Scorer run did not finish")
}
try {
  if (phase === "bootstrap") {
    const config = await call("/api/auth/config")
    assert.deepEqual(config, { emailLink: true, google: true })
    for (const path of [
      "/cms",
      "/cms/login",
      "/cms/api/cms-users/me",
      "/cms-preview",
      "/faq",
      "/pricing",
      "/product/build",
      "/landing-page.md",
      "/api/cms-markdown/landing-page",
    ]) {
      const response = await context.request.get(`${origin}${path}`)
      assert.equal(response.status(), 404, `CMS-off route ${path}`)
    }
    for (const method of [
      "POST",
      "PUT",
      "PATCH",
      "DELETE",
      "OPTIONS",
      "HEAD",
    ]) {
      assert.equal(
        (
          await context.request.fetch(`${origin}/cms/api/pages`, { method })
        ).status(),
        404,
        `CMS-off ${method}`
      )
    }
    assert((await context.request.get(`${origin}/docs`)).ok())
    const sitemap = await (
      await context.request.get(`${origin}/sitemap.xml`)
    ).text()
    assert(sitemap.includes("/docs"))
    assert(!sitemap.includes("/pricing"))
    const google = await call("/api/auth/sign-in/social", {
      provider: "google",
      callbackURL: "/",
      disableRedirect: true,
    })
    const googleURL = new URL(google.url)
    assert.equal(googleURL.hostname, "accounts.google.com")
    assert.equal(
      googleURL.searchParams.get("redirect_uri"),
      `${origin}/api/auth/callback/google`
    )
    // No Google request is followed, and no real email is sent.
    const denied = await context.request.post(
      `${origin}/api/auth/sign-in/magic-link`,
      {
        headers: { origin },
        data: { email: "outsider@denied.test", callbackURL: "/" },
      }
    )
    assert.equal(denied.status(), 403)
    assert(!existsSync(join(directory, "mail/latest.json")))
    await page.goto(origin)
    await page.waitForURL("**/sign-in**")
    await page.getByLabel("Email address").fill("owner@example.test")
    await page.getByRole("button", { name: "Send sign-in link" }).click()
    await page
      .getByRole("status")
      .filter({ hasText: "Check your inbox" })
      .waitFor()
    const mail = JSON.parse(
      readFileSync(join(directory, "mail/latest.json"), "utf8")
    )
    const link = mail.text.match(/https:\/\/\S+/)[0]
    assert.equal(new URL(link).origin, origin)
    await page.goto(link)
    await page.getByRole("link", { name: "New organization", exact: true }).click()
    await page.getByLabel("Organization name").fill("Self Hosting Acceptance")
    await page.screenshot({ path: join(evidence, "organization-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(evidence, "organization-mobile.png") })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.getByRole("button", { name: "Create organization", exact: true }).click()
    await page.getByLabel("Project name").fill("Fresh Install")
    await page.screenshot({ path: join(evidence, "project-desktop.png") })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({ path: join(evidence, "project-mobile.png") })
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page
      .getByRole("button", { name: "Create project", exact: true })
      .click()
    await page.waitForURL("**/fresh-install/traces")
    const session = await call("/api/auth/get-session")
    assert.equal(session.user.email, "owner@example.test")
    assert.equal(session.user.emailVerified, true)
    state.organizationId = session.session.activeOrganizationId
    const projects = await call(
      `/api/organizations/${state.organizationId}/projects`
    )
    assert.equal(projects.projects.length, 1)
    state.projectId = projects.projects[0].id
    const key = await call(
      `/api/organizations/${state.organizationId}/api-keys`,
      {
        name: "Self hosting acceptance",
        scopes: [
          "traces:read",
          "traces:write",
          "scorers:read",
          "scorers:write",
          "evals:read",
          "evals:write",
        ],
        expiresIn: null,
      }
    )
    state.apiKey = key.data.key
    assert(state.apiKey)
    const tracer = createTracer({
      baseUrl: origin,
      projectId: state.projectId,
      apiKey: state.apiKey,
    })
    await tracer.trace(
      {
        name: "Fresh install persisted trace",
        input: { question: "Does self-hosting work?" },
      },
      async (trace) => {
        state.traceId = trace.id
        await tracer.agent({ name: "Sandbox acceptance agent" }, () => ({
          answer: "yes",
        }))
        return { answer: "yes" }
      }
    )
    const trace = await api(`/api/traces/${state.traceId}`)
    assert.equal(trace.status, "completed")
    assert.equal(trace.output.answer, "yes")
    assert(
      trace.spans.some(
        (span: { name: string }) => span.name === "Sandbox acceptance agent"
      )
    )
    for (const [language, code] of [
      [
        "javascript",
        'function evaluate({ trace }) { return { score: trace.output.answer === "yes" ? 1 : 0, passed: true, reason: "Isolated JavaScript" } }',
      ],
      [
        "python",
        'def evaluate(trace, dataset_item=None):\n    return {"score": 1 if trace["output"]["answer"] == "yes" else 0, "passed": True, "reason": "Isolated Python"}',
      ],
    ]) {
      const scorer = await api("/api/evaluators", {
        name: `Self hosted ${language}`,
        language,
        code,
      })
      state.evaluatorIds.push(scorer.id)
    }
    const unconfigured = await api("/api/evals", {
      name: "Missing sandbox fails closed",
      evaluatorIds: [state.evaluatorIds[0]],
      traceIds: [state.traceId],
    })
    const failure = await waitForRun(unconfigured.id)
    assert.equal(failure.results[0].status, "error")
    assert.equal(failure.results[0].score, null)
    assert.match(failure.results[0].error, /No sandbox provider is available/)
    await page.reload()
    await page
      .getByText("Fresh install persisted trace", { exact: true })
      .first()
      .waitFor()
    await page.screenshot({
      path: join(evidence, "first-login-trace-desktop.png"),
    })
    await page.setViewportSize({ width: 390, height: 844 })
    await page.screenshot({
      path: join(evidence, "first-login-trace-mobile.png"),
    })
    const replay = await context.request.get(link, { maxRedirects: 0 })
    assert.match(replay.headers().location, /INVALID_TOKEN/)
    await context.storageState({ path: join(directory, "session.json") })
  } else if (phase === "sandbox") {
    const created = await api("/api/evals", {
      name: "Isolated JavaScript and Python",
      evaluatorIds: state.evaluatorIds,
      traceIds: [state.traceId],
    })
    const run = await waitForRun(created.id)
    assert.equal(run.results.length, 2)
    for (const result of run.results) {
      assert.equal(result.status, "passed", JSON.stringify(result))
      assert.equal(result.score, 1)
      assert.equal(result.passed, true)
      assert.equal(result.error, null)
    }
    state.runIds.push(created.id)
    await page.goto(`${origin}/p/fresh-install/evals/${created.id}`)
    await page
      .getByText("Isolated JavaScript and Python", { exact: true })
      .first()
      .waitFor()
    await page.screenshot({ path: join(evidence, "sandbox-evaluation.png") })
  } else if (phase === "restart") {
    assert.equal(
      (await call("/api/auth/get-session")).user.email,
      "owner@example.test"
    )
    assert.equal(
      (await api(`/api/traces/${state.traceId}`)).output.answer,
      "yes"
    )
    for (const id of state.runIds) {
      const run = await api(`/api/evals/${id}`)
      assert.equal(run.results.length, 2)
      assert(
        run.results.every((result: { score: number }) => result.score === 1)
      )
    }
    await page.goto(`${origin}/p/fresh-install/traces`)
    await page
      .getByText("Fresh install persisted trace", { exact: true })
      .first()
      .waitFor()
    await page.screenshot({ path: join(evidence, "after-recreation.png") })
  } else if (phase === "cms") {
    // Public reads must use an anonymous context, even though our operator has a session.
    const anonymous = await browser.newContext({ ignoreHTTPSErrors: true })
    for (const [path, text] of [
      ["/", "See what your AI is doing."],
      ["/faq", "What is Datool?"],
      ["/landing-page.md", "See what your AI is doing."],
    ]) {
      const response = await anonymous.request.get(`${origin}${path}`)
      assert(response.ok(), `Enabled CMS: ${path}`)
      assert(
        (await response.text()).includes(text),
        `Enabled CMS content: ${path}`
      )
    }
    const cms = await anonymous.request.get(`${origin}/cms/api/cms-users/me`)
    assert(cms.ok())
    assert.equal((await cms.json()).user, null)
    const create = await anonymous.request.post(`${origin}/cms/api/pages`, {
      data: { title: "Denied" },
    })
    assert([401, 403].includes(create.status()))
    await anonymous.close()
  } else throw new Error(`Unknown phase: ${phase}`)
  assert.deepEqual(pageErrors, [], "Browser runtime errors")
  writeFileSync(stateFile, JSON.stringify(state), { mode: 0o600 })
  writeFileSync(
    join(evidence, `${phase}.json`),
    JSON.stringify(
      { phase, passed: true, checkedAt: new Date().toISOString() },
      null,
      2
    )
  )
  console.log(`Self-hosting ${phase}: passed`)
} catch (error) {
  writeFileSync(
    join(evidence, `${phase}-failure.json`),
    JSON.stringify({ pageErrors, path: new URL(page.url()).pathname }, null, 2)
  )
  await page
    .screenshot({ path: join(evidence, `${phase}-failure.png`) })
    .catch(() => {})
  throw error
} finally {
  await browser.close()
}
