/** Real cross-origin iframe lifecycle; API/configuration responses are fixtures. */
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { chromium } from "playwright"

const widget = await readFile(
  new URL("../public/datool-widget.js", import.meta.url),
  "utf8"
)
const browser = await chromium.launch({ headless: true })
const frameDocument = `<!doctype html><html><body>
  <input id="draft" aria-label="Message"><output id="visible"></output>
  <script>
    addEventListener('message', event => {
      if (event.source !== parent || event.origin !== 'https://storefront.test') return;
      if (event.data.type === 'datool:chat:visibility') {
        document.querySelector('#visible').textContent = String(event.data.visible);
      }
    });
    parent.postMessage({ type: 'datool:chat:ready' }, 'https://storefront.test');
  </script>
</body></html>`

try {
  for (const scenario of ["preload", "early-open", "unavailable"] as const) {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
    })
    let frameRequests = 0
    let releaseFrame!: () => void
    const frameGate = new Promise<void>((resolve) => {
      releaseFrame = resolve
    })
    if (scenario !== "early-open") releaseFrame()
    await page.route("https://storefront.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: '<!doctype html><html><body><h1>Store</h1><script src="https://chat.test/datool-widget.js" data-channel-id="test"></script></body></html>',
      })
    )
    await page.route("https://chat.test/datool-widget.js", (route) =>
      route.fulfill({
        contentType: "application/javascript",
        body: widget,
      })
    )
    await page.route(
      "https://chat.test/api/build-public/test/appearance",
      (route) =>
        route.fulfill({
          status: scenario === "unavailable" ? 404 : 200,
          headers: { "access-control-allow-origin": "https://storefront.test" },
          json: {
            data: {
              appearance: {
                displayName: "Store",
                radius: "medium",
                offsetX: 16,
                offsetY: 16,
                fontSize: 14,
              },
              launcher: {
                color: "#151518",
                openLabel: "Open chat",
                closeLabel: "Close chat",
              },
            },
          },
        })
    )
    await page.route("https://chat.test/chat/**", async (route) => {
      frameRequests++
      await frameGate
      await route.fulfill({ contentType: "text/html", body: frameDocument })
    })
    const appearanceResponse = page.waitForResponse(
      "https://chat.test/api/build-public/test/appearance"
    )
    await page.goto("https://storefront.test/", {
      waitUntil: "domcontentloaded",
    })
    await appearanceResponse
    if (scenario === "unavailable") {
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await page.locator("[data-datool-widget]").count(), 0)
      assert.equal(frameRequests, 0)
    } else {
      const launcher = page.getByRole("button", { name: "Open chat" })
      await launcher.waitFor()
      const frame = page.frameLocator("[data-datool-widget] iframe")
      if (scenario === "preload") {
        // A hidden lazy iframe never reaches this state before a click.
        await frame
          .locator("#draft")
          .waitFor({ state: "attached", timeout: 2500 })
        assert.equal(await page.locator("iframe").isVisible(), false)
      }
      const openedAt = performance.now()
      await launcher.click()
      releaseFrame()
      await frame.locator("#visible").filter({ hasText: "true" }).waitFor()
      const openMs = Math.round(performance.now() - openedAt)
      await frame
        .getByRole("textbox", { name: "Message" })
        .fill("Retain this draft")
      await page.getByRole("button", { name: "Close chat" }).click()
      await frame
        .locator("#visible")
        .filter({ hasText: "false" })
        .waitFor({ state: "attached" })
      await page.getByRole("button", { name: "Open chat" }).click()
      assert.equal(
        await frame.getByRole("textbox", { name: "Message" }).inputValue(),
        "Retain this draft"
      )
      assert.equal(frameRequests, 1)
      // An unrelated window must not control this iframe.
      await page.evaluate(() =>
        window.postMessage({ type: "datool:chat:close" }, "*")
      )
      await page.evaluate(() => new Promise(requestAnimationFrame))
      assert.equal(await page.locator("iframe").isVisible(), true)
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth
        ),
        false
      )
      console.log(
        `${scenario}: one iframe navigation, retained draft, open acknowledgement ${openMs}ms (local fixture)`
      )
    }
    releaseFrame()
    await page.close()
  }
} finally {
  await browser.close()
}
