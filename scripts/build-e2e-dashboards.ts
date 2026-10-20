import assert from "node:assert/strict"
import { join } from "node:path"
import type { Page } from "playwright"

export async function runBuildDashboardE2e({
  page,
  prefix,
  messageCount,
  handoffCount = 2,
  evidence,
  passed,
}: {
  page: Page
  prefix: string
  messageCount: number
  handoffCount?: number
  evidence: string
  passed: (message: string) => void
}) {
  const dashboards = `${prefix.replace(/\/build$/, "")}/dashboards`
  const dashboardsPath = new URL(dashboards).pathname
  await page.goto(`${prefix}/analytics`, {
    waitUntil: "networkidle",
    timeout: 120_000,
  })
  assert.equal(new URL(page.url()).pathname, dashboardsPath)
  await page
    .getByText("Saved configuration is not supported by this version.", {
      exact: true,
    })
    .waitFor()
  assert.equal(
    await page
      .getByRole("link", { name: "Conversation analytics", exact: true })
      .count(),
    0
  )
  // The sidebar preference is shared across desktop and mobile. Close it before
  // resizing so its mobile drawer does not cover the dashboard controls.
  const sidebarToggle = page
    .getByRole("button", { name: "Toggle sidebar", exact: true })
    .and(page.locator('[aria-expanded="true"]'))
  if (await sidebarToggle.isVisible()) await sidebarToggle.click()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole("button", { name: "New dashboard", exact: true }).click()
  const dialog = page.getByRole("dialog")
  await dialog.getByText("Customer experience", { exact: true }).click()
  await dialog
    .getByRole("textbox", { name: "Dashboard name", exact: true })
    .fill("Customer support")
  await page.screenshot({
    path: join(evidence, "customer-experience-template-mobile.png"),
    fullPage: true,
  })
  await page.setViewportSize({ width: 1440, height: 1000 })
  const create = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/api/dashboards"
  )
  await dialog
    .getByRole("button", { name: "Create dashboard", exact: true })
    .click()
  const response = await create
  assert(response.ok(), `Create dashboard: HTTP ${response.status()}`)
  await page.waitForURL((url) => url.pathname.startsWith(`${dashboardsPath}/`))
  const dashboardUrl = page.url()
  const metric = (id: string) =>
    page.locator(`[data-widget-id="${id}"] p[title]`)
  await metric("messages").waitFor()
  assert.equal(
    (await metric("messages").innerText()).trim(),
    String(messageCount)
  )
  assert.equal(
    (await metric("handoffs").innerText()).trim(),
    String(handoffCount)
  )
  assert.equal(await page.locator("[data-widget-id]").count(), 15)
  assert.equal(await page.locator('main [role="alert"]').count(), 0)
  await page
    .getByRole("search", { name: "Filter dashboard dates", exact: true })
    .waitFor()
  await page.getByRole("button", { name: "More actions", exact: true }).click()
  await page
    .getByRole("menuitem", { name: "Edit dashboard", exact: true })
    .click()
  await page.getByRole("button", { name: "Edit Messages", exact: true }).click()
  const save = page.waitForResponse(
    (result) =>
      result.request().method() === "PATCH" &&
      new URL(result.url()).pathname.startsWith("/api/dashboards/")
  )
  await page
    .getByRole("textbox", { name: "Title", exact: true })
    .fill("Customer messages")
  assert(
    (await save).ok(),
    "The edited template widget must persist through the normal dashboard API."
  )
  await page.getByRole("button", { name: "Done editing", exact: true }).click()
  await page.reload({ waitUntil: "networkidle" })
  await page
    .locator('[data-widget-id="messages"]')
    .getByText("Customer messages", { exact: true })
    .waitFor()
  await metric("messages").waitFor()
  assert.equal(
    (await metric("messages").innerText()).trim(),
    String(messageCount)
  )
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 })
    await page.goto(dashboardUrl, { waitUntil: "networkidle" })
    await metric("messages").waitFor()
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    )
    assert.equal(
      overflow,
      false,
      `Customer experience dashboard overflows at ${width}px`
    )
    assert.equal(await page.locator('main [role="alert"]').count(), 0)
    await page.screenshot({
      path: join(
        evidence,
        `customer-experience-${width === 390 ? "mobile" : "desktop"}.png`
      ),
      fullPage: true,
    })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  passed(
    `Build analytics redirects to Dashboards; the customer experience template renders ${messageCount} messages and ${handoffCount} handoffs, supports saved widget edits, and fits desktop and mobile`
  )
}
