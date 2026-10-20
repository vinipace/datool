import assert from "node:assert/strict"
import { join } from "node:path"
import type { Locator, Page } from "playwright"

type UiOptions = {
  page: Page
  prefix: string
  agentId: string
  evidence: string
  passed: (message: string) => void
}

async function openAgentNavigation(page: Page) {
  const navigation = page.getByRole("list", {
    name: "Agent sections",
    exact: true,
  })
  if (!(await navigation.isVisible())) {
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .and(page.locator("[aria-expanded]"))
      .click()
  }
  await navigation.waitFor({ state: "visible" })
  return navigation
}

export async function selectAgentSection(
  page: Page,
  label: string,
  value = label === "Analytics"
    ? "overview"
    : label === "Data sources"
      ? "knowledge"
      : label.toLowerCase().replaceAll(" ", "-")
) {
  const navigation = await openAgentNavigation(page)
  const link = navigation.getByRole("link", { name: label, exact: true })
  if (!(await link.isVisible())) {
    const group = ["Inbox", "Leads", "Collected data"].includes(label)
      ? "Activity"
      : "Build"
    await navigation.getByRole("button", { name: group, exact: true }).click()
  }
  await link.click()
  await page.waitForURL((url) => url.searchParams.get("section") === value)
  if ((page.viewportSize()?.width ?? 1440) < 768)
    await navigation.waitFor({ state: "hidden" })
}

async function saveDialog(page: Page, operation: string, button: string) {
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("button", { name: button, exact: true }) })
  const response = page.waitForResponse(
    (result) =>
      result.request().method() === "POST" &&
      new URL(result.url()).pathname.endsWith(`/api/build/${operation}`)
  )
  await dialog.getByRole("button", { name: button, exact: true }).click()
  const result = await response
  assert(result.ok(), `${operation}: HTTP ${result.status()}`)
  await dialog.waitFor({ state: "hidden" })
  return (await result.json()).data
}

async function assertFitsViewport(page: Page, label: string) {
  const sizes = await page.evaluate(() => ({
    width: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
  }))
  assert(
    sizes.document <= sizes.width + 1 && sizes.body <= sizes.width + 1,
    `${label} overflows the viewport: ${JSON.stringify(sizes)}`
  )
  const clipped = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll("button, input, textarea, select")
    ).flatMap((element) => {
      if (element.closest('table, [aria-hidden="true"]')) return []
      const bounds = element.getBoundingClientRect()
      if (!bounds.width || !bounds.height) return []
      return bounds.left < -1 || bounds.right > window.innerWidth + 1
        ? [
            element.getAttribute("aria-label") ||
              element.getAttribute("placeholder") ||
              element.textContent?.trim().slice(0, 60) ||
              element.tagName,
          ]
        : []
    })
  )
  assert.deepEqual(
    clipped,
    [],
    `${label} clips controls outside the visible viewport`
  )
}

async function failSaveInView(
  page: Page,
  dialog: Locator,
  operation: string,
  button: string | (() => Promise<void>)
) {
  const pattern = `**/api/build/${operation}`
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  const message = "Temporary validation outage. Your draft is still here."
  await page.route(pattern, async (route) => {
    await pending
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "x-build-e2e-fault": "expected" },
      body: JSON.stringify({ error: { code: "SERVICE_UNAVAILABLE", message } }),
    })
  })
  try {
    const received = page.waitForRequest(pattern)
    if (typeof button === "function") await button()
    else await dialog.getByRole("button", { name: button, exact: true }).click()
    await received
    await page.keyboard.press("Escape")
    assert(await dialog.isVisible(), `${operation} hid its pending save`)
    release()
    await dialog.getByRole("alert").filter({ hasText: message }).waitFor()
  } finally {
    release()
    await page.unroute(pattern)
  }
}

/** UI workflows use the disposable project already owned by the main harness. */
export async function runBuildUiE2e({
  page,
  prefix,
  agentId,
  evidence,
  passed,
}: UiOptions) {
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.goto(`${prefix}/contacts`, { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "New contact", exact: true }).click()
  const contactDialog = page.getByRole("dialog", {
    name: "Create contact",
    exact: true,
  })
  await contactDialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser UX customer")
  await contactDialog
    .getByRole("textbox", { name: "Email", exact: true })
    .fill("browser-ux@example.test")
  const contact = await saveDialog(
    page,
    "build_create_contact",
    "Create contact"
  )
  assert(contact.id)
  await page.getByText("Browser UX customer", { exact: true }).first().waitFor()

  await page.goto(`${prefix}/campaigns`, { waitUntil: "networkidle" })
  await page.getByRole("button", { name: "New campaign", exact: true }).click()
  await page
    .getByRole("textbox", { name: "Campaign name", exact: true })
    .fill("Browser UX draft")
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("A saved draft for the browser validation. Do not send.")
  const campaign = await saveDialog(
    page,
    "build_create_campaign",
    "Create campaign"
  )
  assert.equal(campaign.name, "Browser UX draft")
  assert.equal(
    campaign.template.text,
    "A saved draft for the browser validation. Do not send."
  )

  await page.goto(`${prefix}/integrations`, { waitUntil: "networkidle" })
  const channelAgent = page.getByRole("combobox", {
    name: "Channel agent",
    exact: true,
  })
  await channelAgent.selectOption("")
  assert.equal(
    await channelAgent.inputValue(),
    "",
    "Clearing the channel agent silently selected another agent"
  )
  assert(
    await page
      .getByRole("button", { name: "Connect channel", exact: true })
      .isDisabled()
  )
  await channelAgent.selectOption(agentId)
  await page
    .getByRole("button", { name: "Connect channel", exact: true })
    .click()
  const channelEditor = page.getByRole("region", { name: "Chat Bubble editor" })
  await channelEditor.waitFor()
  await page.getByRole("tab", { name: "Overview", exact: true }).click()
  await failSaveInView(
    page,
    channelEditor,
    "build_update_channel",
    async () => {
      await channelEditor
        .getByLabel("Connection name", { exact: true })
        .fill("Unsaved channel")
    }
  )
  assert.equal(
    await channelEditor
      .getByLabel("Connection name", { exact: true })
      .inputValue(),
    "Unsaved channel"
  )
  await page.getByRole("button", { name: "Channels", exact: true }).click()
  await channelEditor.waitFor({ state: "hidden" })

  await page.goto(`${prefix}/tests`, { waitUntil: "networkidle" })
  const testAgent = page.getByRole("combobox", {
    name: "Test agent",
    exact: true,
  })
  await testAgent.selectOption("")
  assert.equal(
    await testAgent.inputValue(),
    "",
    "Clearing the test agent silently selected another agent"
  )
  assert(
    await page
      .getByRole("button", { name: "New test", exact: true })
      .isDisabled()
  )
  await testAgent.selectOption(agentId)
  await page.getByRole("button", { name: "New test", exact: true }).click()
  const testDialog = page.getByRole("dialog")
  await testDialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Browser UX scenario")
  await testDialog
    .getByRole("textbox", { name: "Scenario", exact: true })
    .fill("A customer asks about the return policy.")
  await testDialog
    .getByRole("textbox", { name: /^Initial customer message/ })
    .fill("What is the return window?")
  await testDialog
    .getByRole("textbox", { name: /^Success criteria/ })
    .fill("The agent answers from its knowledge.")
  await failSaveInView(
    page,
    testDialog,
    "build_create_simulation",
    "Create test"
  )
  assert.equal(
    await testDialog
      .getByRole("textbox", { name: "Name", exact: true })
      .inputValue(),
    "Browser UX scenario"
  )
  const simulation = await saveDialog(
    page,
    "build_create_simulation",
    "Create test"
  )
  assert.equal(simulation.name, "Browser UX scenario")
  passed(
    "browser creates a contact, plain-text campaign draft and customer test through focused dialogs"
  )

  const runFailure = "The test worker is temporarily unavailable."
  await page.route("**/api/build/build_start_simulation", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      headers: { "x-build-e2e-fault": "expected" },
      body: JSON.stringify({
        error: { code: "SERVICE_UNAVAILABLE", message: runFailure },
      }),
    })
  )
  await page.getByRole("button", { name: "Run", exact: true }).first().click()
  await page.getByText(runFailure, { exact: true }).waitFor()
  await page.unroute("**/api/build/build_start_simulation")

  await page.goto(`${prefix}/agents/${agentId}`, { waitUntil: "networkidle" })
  await selectAgentSection(page, "Data sources")
  await page.getByRole("button", { name: "Add source", exact: true }).click()
  const sourceDialog = page.getByRole("dialog")
  await sourceDialog
    .getByRole("textbox", { name: "Name", exact: true })
    .fill("Unsaved source")
  await sourceDialog
    .getByRole("textbox", { name: "Source content", exact: true })
    .fill("A draft that must survive a failed save.")
  await failSaveInView(
    page,
    sourceDialog,
    "build_create_knowledge_source",
    "Add source"
  )
  assert.equal(
    await sourceDialog
      .getByRole("textbox", { name: "Name", exact: true })
      .inputValue(),
    "Unsaved source"
  )
  await page.keyboard.press("Escape")
  await sourceDialog.waitFor({ state: "hidden" })
  passed(
    "cleared agent scopes stay empty, failed saves retain visible drafts, and failed test runs show an error without an unhandled rejection"
  )

  const routes = [
    "agents",
    "conversations",
    "inbox",
    "contacts",
    "campaigns",
    "integrations",
    "suggestions",
    "tests",
  ]
  const sections = [
    "Analytics",
    "Instructions",
    "Guardrails",
    "Settings",
    "Data sources",
    "Actions",
    "Procedures",
    "Widgets",
    "Channels",
    "Leads",
    "Collected data",
  ]
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    const size = width === 390 ? "mobile" : "desktop"
    for (const route of routes) {
      await page.goto(`${prefix}/${route}`, { waitUntil: "networkidle" })
      await assertFitsViewport(page, `${route} ${size}`)
      await page.screenshot({
        path: join(evidence, `${route}-${size}.png`),
        fullPage: true,
      })
    }
    await page.goto(`${prefix}/agents/${agentId}`, { waitUntil: "networkidle" })
    await selectAgentSection(page, "Instructions")
    const instructions = page.getByRole("textbox", {
      name: "System instructions",
      exact: true,
    })
    const originalInstructions = await instructions.inputValue()
    const editedInstructions = `${originalInstructions}\nBrowser navigation check.`
    await instructions.fill(editedInstructions)
    if (width === 1440) {
      await selectAgentSection(page, "Guardrails")
      await page
        .getByRole("link", { name: "Guardrails", exact: true })
        .and(page.locator('[aria-current="page"]'))
        .waitFor()
      await page.goBack()
      await instructions.waitFor({ state: "visible" })
      await page.goForward()
      await page
        .getByRole("link", { name: "Guardrails", exact: true })
        .and(page.locator('[aria-current="page"]'))
        .waitFor()
    }
    await selectAgentSection(page, "Guardrails")
    await selectAgentSection(page, "Instructions")
    assert.equal(await instructions.inputValue(), editedInstructions)
    await instructions.fill(originalInstructions)
    await page
      .getByRole("status")
      .filter({ hasText: /^Saved$/ })
      .waitFor()
    for (const section of sections) {
      await selectAgentSection(page, section)
      // Wait for saved resources, not a previously idle document before the
      // section's effect has started its read.
      if (section === "Data sources")
        await page.getByText("Returns", { exact: true }).waitFor()
      if (["Actions", "Procedures", "Widgets"].includes(section)) {
        const list =
          section === "Actions"
            ? page.getByRole("tabpanel", { name: "My Actions", exact: true })
            : page.getByRole("region", { name: section, exact: true })
        await list.getByRole("button", { name: /^E2E .* edited/ }).waitFor()
      }
      if (section === "Channels")
        await page.getByText("Website validation", { exact: true }).waitFor()
      await assertFitsViewport(page, `agent ${section} ${size}`)
      const mainSize = await page
        .locator("main")
        .last()
        .evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
        }))
      assert(
        mainSize.content <= mainSize.width + 1,
        `agent ${section} ${size} clips its content horizontally: ${JSON.stringify(mainSize)}`
      )
      await page.screenshot({
        path: join(evidence, `agent-${section.toLowerCase()}-${size}.png`),
        fullPage: true,
      })
    }
    await page.goto(`${prefix}/agents/${agentId}/playground`, {
      waitUntil: "networkidle",
    })
    const navigation = await openAgentNavigation(page)
    assert.equal(
      await navigation
        .getByRole("link", { name: "Playground", exact: true })
        .count(),
      0
    )
    await page
      .getByText("Waiting for the agent…", { exact: true })
      .waitFor({ state: "hidden" })
    await page.screenshot({
      path: join(evidence, `agent-sidebar-${size}.png`),
      fullPage: true,
    })
    if (width === 390) await page.keyboard.press("Escape")
    await assertFitsViewport(page, `standalone playground ${size}`)
    await openAgentNavigation(page)
    const parent = page.getByRole("link", {
      name: "Build validation agent — back to agents",
      exact: true,
    })
    assert.equal(
      new URL((await parent.getAttribute("href"))!, page.url()).href,
      `${prefix}/agents`
    )
    await parent.click()
    await page.getByRole("link", { name: "New agent", exact: true }).waitFor()
    const toggle = page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .and(page.locator("[aria-expanded]"))
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click()
    assert.equal(
      await page
        .getByRole("list", { name: "Agent sections", exact: true })
        .count(),
      0
    )
    assert(
      await page.getByRole("link", { name: "Agents", exact: true }).isVisible()
    )
    if (width === 390) await page.keyboard.press("Escape")
  }
  passed(
    "all Build pages and agent sections fit desktop and mobile, preserve unsaved drafts, and open the direct playground route"
  )

  // The mobile inspector is a real focus-contained sheet, not a hidden desktop panel.
  await page.goto(`${prefix}/contacts`, { waitUntil: "networkidle" })
  await page.getByText("Browser UX customer", { exact: true }).click()
  const sheet = page.getByRole("dialog")
  await sheet.waitFor()
  for (let index = 0; index < 14; index++) {
    await page.keyboard.press("Tab")
    assert(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('[role="dialog"]'))
      ),
      "Mobile inspector focus escaped its dialog"
    )
  }
  await assertFitsViewport(page, "mobile contact details")
  await page.screenshot({
    path: join(evidence, "contact-details-mobile.png"),
    fullPage: true,
  })
  await page.keyboard.press("Escape")
  await sheet.waitFor({ state: "hidden" })
  assert(
    await page.getByText("Browser UX customer", { exact: true }).isVisible()
  )
  passed(
    "mobile contact details contain keyboard focus and close with Escape without losing the directory"
  )
}
