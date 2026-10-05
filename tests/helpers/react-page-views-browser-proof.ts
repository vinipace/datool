import assert from "node:assert/strict"
import { resolve } from "node:path"
import type { BrowserContext, Page } from "playwright"

/** The real UI, sandbox bridge and authenticated API own this feature's proof. */
export async function verifyReactPageViews({ page, owner, teammate, base, projectId, output }: {
  page: Page
  owner: BrowserContext
  teammate: BrowserContext
  base: string
  projectId: string
  output: string
}) {
  const headers = { "x-project-id": projectId, origin: base }
  const objectResponse = await owner.request.post(base + "/api/object-views", {
    headers, data: {
      name: "Page-selected object", description: "", dataMode: "summary", requirements: [],
      objectTypes: ["trace"], source: null,
      code: 'import * as React from "react"; export default function View({ object }: ViewProps) { return <h2>Selected object: {object.name}</h2> }',
    },
  })
  assert.equal(objectResponse.status(), 200)
  const objectView = (await objectResponse.json()).data
  const source = `import * as React from "react";
import { Button } from "@datool/ui";
export default function Page({ rows, page, openTrace, refresh, loadMore }: PageViewProps<{ id: string; name: string }>) {
  const [count, setCount] = React.useState(0);
  const inspectFirst = React.useCallback(() => openTrace("view-source", { objectViewId: "${objectView.id}" }), []);
  return <div className="space-y-3 p-3">
    <h1>Custom trace page</h1>
    <p>Loaded rows: {rows.length}</p>
    <Button onClick={() => setCount(n => n + 1)}>Page clicks {count}</Button>
    <Button onClick={refresh}>Refresh page</Button>
    <Button onClick={inspectFirst}>Inspect first trace</Button>
    {rows.map(row => <div key={row.id}><span>{row.name}</span><Button onClick={() => openTrace(row.id, { objectViewId: "${objectView.id}" })}>Inspect {row.name}</Button></div>)}
    {rows.length === 0 && <p>Custom empty state</p>}
    {page.hasMore && <Button onClick={loadMore}>More traces</Button>}
  </div>;
}`
  const frames = () => page.frameLocator('iframe[title="React view preview"]')
  const openMenu = async () => page.getByRole("combobox", { name: "Page View", exact: true }).click()
  const setCode = async (code: string) => {
    await page.getByRole("textbox", { name: "View code", exact: true }).focus()
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.insertText(code)
  }
  await page.goto(base + "/p/views-e2e/traces")
  await openMenu()
  await page.getByRole("button", { name: "Create React Page View", exact: true }).click()
  await page.getByLabel("View name", { exact: true }).fill("Custom trace page")
  await setCode(source)
  await page.getByRole("tab", { name: "Preview", exact: true }).click()
  await frames().getByRole("heading", { name: "Custom trace page" }).waitFor()
  await frames().getByRole("button", { name: "Inspect first trace", exact: true }).click()
  await page.frameLocator('iframe[title="React view preview"]').nth(1)
    .getByRole("heading", { name: "Selected object: Original answer", exact: true }).waitFor()
  await page.getByRole("dialog").getByRole("button", { name: "Close trace inspector", exact: true }).click()
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await frames().getByText("Loaded rows: 3", { exact: true }).waitFor()
  await frames().getByRole("button", { name: "Page clicks 0" }).click()
  await frames().getByRole("button", { name: "Refresh page", exact: true }).click()
  await frames().getByRole("button", { name: "Page clicks 1" }).waitFor()
  await page.screenshot({ path: resolve(output, "react-page-desktop.png") })
  await page.waitForFunction(() => new URL(window.location.href).searchParams.has("pageView"))
  const sharedUrl = await page.evaluate(() => window.location.href)
  const viewId = new URL(sharedUrl).searchParams.get("pageView")
  assert(viewId)
  const stored = await owner.request.get(base + "/api/page-views/" + viewId, { headers })
  assert.equal(stored.status(), 200)
  assert.equal((await page.locator('iframe[title="React view preview"]').getAttribute("sandbox")), "allow-scripts")
  // Messages from another window must not open a trace.
  await page.evaluate(() => window.postMessage({ type: "page-view-action", token: "forged", action: "openTrace", payload: { traceId: "view-source" } }, "*"))
  await page.evaluate(() => new Promise(requestAnimationFrame))
  assert.equal(await page.getByRole("combobox", { name: "View", exact: true }).count(), 0)
  await frames().getByRole("button", { name: "Inspect first trace", exact: true }).click()
  await page.getByRole("button", { name: "Views", exact: true }).waitFor()
  await page.getByRole("combobox", { name: "View", exact: true }).waitFor()
  await page.frameLocator('iframe[title="React view preview"]').nth(1)
    .getByRole("heading", { name: "Selected object: Original answer", exact: true }).waitFor()
  await page.getByRole("button", { name: "Close trace inspector", exact: true }).click()
  await page.waitForFunction(() => document.activeElement?.tagName === "IFRAME")
  await frames().getByRole("button", { name: "Page clicks 1" }).waitFor()
  await page.reload()
  await frames().getByText("Loaded rows: 3", { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await openMenu()
  await page.getByRole("button", { name: "Edit React component", exact: true }).click()
  await page.getByRole("textbox", { name: "View code", exact: true }).waitFor()
  await page.getByLabel("View name", { exact: true }).focus()
  await page.screenshot({ path: resolve(output, "react-page-editor-mobile.png") })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await setCode(source.replace("Custom trace page</h1>", "Revised trace page</h1>"))
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await frames().getByRole("heading", { name: "Revised trace page" }).waitFor()
  await page.screenshot({ path: resolve(output, "react-page-mobile.png") })
  const other = await teammate.newPage()
  try {
    await other.goto(sharedUrl)
    await other.frameLocator('iframe[title="React view preview"]').getByRole("heading", { name: "Revised trace page" }).waitFor()
  } finally { await other.close() }
  await openMenu()
  await page.getByRole("option", { name: "All Logs", exact: true }).click()
  await page.getByRole("row").filter({ hasText: "Original answer" }).first().waitFor()
  assert.equal(await page.locator('iframe[title="React view preview"]').count(), 0)
  // A different collection gets its actual row contract and can open traces too.
  const datasetSource = `import * as React from "react";
import { Button } from "@datool/ui";
export default function Page({ rows, openTrace }: PageViewProps<{ id: string }>) {
  return <div><h1>Custom dataset page</h1><p>Dataset row: {rows[0]?.id}</p>
    <Button onClick={() => openTrace("view-other", { objectViewId: "${objectView.id}" })}>Inspect source trace</Button></div>;
}`
  const datasetResponse = await owner.request.post(base + "/api/page-views", {
    headers, data: { resource: "dataset-items", name: "Dataset React page", settings: { schemaVersion: 1, renderer: { kind: "react", code: datasetSource } } },
  })
  assert.equal(datasetResponse.status(), 200)
  const datasetView = (await datasetResponse.json()).data
  await page.goto(base + "/p/views-e2e/datasets/view-dataset?pageView=" + datasetView.id)
  await frames().getByRole("heading", { name: "Custom dataset page" }).waitFor()
  await frames().getByText("Dataset row: view-row", { exact: true }).waitFor()
  await frames().getByRole("button", { name: "Inspect source trace" }).click()
  await page.frameLocator('iframe[title="React view preview"]').nth(1)
    .getByRole("heading", { name: "Selected object: Different operation" }).waitFor()
  await page.getByRole("button", { name: "Close trace inspector", exact: true }).click()
  // Runtime failure is visible, and switching back to the table remains possible.
  const bad = await owner.request.put(base + "/api/page-views/" + datasetView.id, {
    headers, data: { resource: "dataset-items", name: datasetView.name, expectedRevision: 1,
      settings: { schemaVersion: 1, renderer: { kind: "react", code: 'export default function Page() { throw new Error("Page render failure") }' } } },
  })
  assert.equal(bad.status(), 200)
  await page.reload()
  await page.getByRole("alert").filter({ hasText: "Page render failure" }).waitFor()
  await openMenu()
  await page.getByRole("option", { name: "All dataset items", exact: true }).click()
  await page.getByRole("row", { name: "Open dataset row 1", exact: true }).waitFor()
  await page.setViewportSize({ width: 1440, height: 1000 })
  await verifyMdxPageView(page, owner, teammate, base, headers, objectView.id, output)
  assert.equal((await owner.request.delete(base + "/api/page-views/" + viewId + "?expectedRevision=2", { headers })).status(), 200)
  assert.equal((await owner.request.delete(base + "/api/page-views/" + datasetView.id + "?expectedRevision=2", { headers })).status(), 200)
  assert.equal((await owner.request.delete(base + "/api/object-views/" + objectView.id + "?expectedRevision=1", { headers })).status(), 200)
  return { createPreviewSaveReloadEdit: true, sharedAcrossBrowsers: true, traceAndDatasetCollections: true, selectedObjectView: true, darkDesktopAndMobile: true, runtimeErrorRecovery: true, mdxAuthoringAndNavigation: true }
}

async function verifyMdxPageView(page: Page, owner: BrowserContext, teammate: BrowserContext, base: string, headers: Record<string, string>, objectViewId: string, output: string) {
  const source = `import * as React from "react"
import { Button } from "@datool/ui"

export function Counter() { const [count, setCount] = React.useState(0); return <Button onClick={() => setCount(n => n + 1)}>MDX clicks {count}</Button> }

# MDX review queue

Loaded rows: {props.rows.length}

Compiled worker &amp; live rows.

<Counter />

<Button onClick={props.refresh}>Refresh MDX</Button>

<TraceButton traceId="view-source" objectViewId="${objectViewId}">Inspect MDX trace</TraceButton>

<DataTable data={props.rows} columns={[{accessorKey: "name", header: "Trace name"}]} />
`
  const frame = () => page.frameLocator('iframe[title="React view preview"]')
  const menu = async () => page.getByRole("combobox", { name: "Page View", exact: true }).click()
  const edit = async (value: string) => {
    await page.getByRole("textbox", { name: "Page MDX source", exact: true }).focus()
    await page.keyboard.press("ControlOrMeta+A")
    await page.keyboard.insertText(value)
  }
  await page.goto(base + "/p/views-e2e/traces")
  await menu()
  await page.getByRole("button", { name: "Create MDX Page View", exact: true }).click()
  await page.getByLabel("View name", { exact: true }).fill("MDX review queue")
  await edit("# Invalid\n\n<Card>")
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("dialog").getByRole("alert").waitFor()
  assert.equal(await page.getByLabel("View name", { exact: true }).inputValue(), "MDX review queue")
  await edit(source)
  await page.getByRole("tab", { name: "Preview", exact: true }).click()
  await frame().getByRole("heading", { name: "MDX review queue", exact: true }).waitFor()
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await frame().getByText("Loaded rows: 3", { exact: true }).waitFor()
  await frame().getByText("Compiled worker & live rows.", { exact: true }).waitFor()
  await frame().getByRole("cell", { name: "Original answer", exact: true }).waitFor()
  await frame().getByRole("button", { name: "MDX clicks 0" }).click()
  await frame().getByRole("button", { name: "Refresh MDX", exact: true }).click()
  await frame().getByRole("button", { name: "MDX clicks 1" }).waitFor()
  await page.screenshot({ path: resolve(output, "mdx-page-desktop.png") })
  await frame().getByRole("button", { name: "Inspect MDX trace", exact: true }).click()
  await page.frameLocator('iframe[title="React view preview"]').nth(1)
    .getByRole("heading", { name: "Selected object: Original answer", exact: true }).waitFor()
  await page.getByRole("button", { name: "Close trace inspector", exact: true }).click()
  const sharedUrl = page.url()
  const id = new URL(sharedUrl).searchParams.get("pageView")
  assert(id)
  const stored = await owner.request.get(base + "/api/page-views/" + id, { headers })
  assert.equal(stored.status(), 200)
  assert.equal((await stored.json()).data.settings.renderer.kind, "mdx")
  await page.reload()
  await frame().getByText("Loaded rows: 3", { exact: true }).waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await menu()
  await page.getByRole("button", { name: "Edit MDX document", exact: true }).click()
  await page.getByRole("textbox", { name: "Page MDX source", exact: true }).waitFor()
  await page.getByLabel("View name", { exact: true }).focus()
  await page.screenshot({ path: resolve(output, "mdx-page-editor-mobile.png") })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
  await edit(source.replace("# MDX review queue", "# Updated MDX queue"))
  await page.getByRole("button", { name: "Save view", exact: true }).click()
  await page.getByRole("dialog").waitFor({ state: "hidden" })
  await frame().getByRole("heading", { name: "Updated MDX queue", exact: true }).waitFor()
  await page.screenshot({ path: resolve(output, "mdx-page-mobile.png") })
  const other = await teammate.newPage()
  try {
    await other.goto(sharedUrl)
    await other.frameLocator('iframe[title="React view preview"]').getByRole("heading", { name: "Updated MDX queue", exact: true }).waitFor()
  } finally { await other.close() }
  const broken = await owner.request.put(base + "/api/page-views/" + id, { headers, data: {
    resource: "traces", name: "MDX review queue", expectedRevision: 2,
    settings: { schemaVersion: 1, renderer: { kind: "mdx", code: "# Broken\n\n{" } },
  } })
  assert.equal(broken.status(), 200)
  await page.reload()
  await page.getByRole("alert").filter({ hasText: /expression|brace/ }).waitFor()
  await menu()
  await page.getByRole("option", { name: "All Logs", exact: true }).click()
  await page.getByRole("row").filter({ hasText: "Original answer" }).first().waitFor()
  assert.equal((await owner.request.delete(base + "/api/page-views/" + id + "?expectedRevision=3", { headers })).status(), 200)
  await page.setViewportSize({ width: 1440, height: 1000 })
}
