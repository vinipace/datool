import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createRequire } from "node:module"
import { chromium } from "playwright"
import postcss from "postcss"

const root = new URL("../", import.meta.url)
const require = createRequire(import.meta.url)
const [template, css, logo, font] = await Promise.all([
  readFile(new URL("assets/social-preview.html", root), "utf8"),
  readFile(new URL("app/globals.css", root), "utf8"),
  readFile(new URL("app/icon.svg", root), "base64"),
  readFile(
    require.resolve("next/dist/compiled/@vercel/og/Geist-Regular.ttf"),
    "base64"
  ),
])

// Reuse the real theme; the standalone artwork has no separate color palette.
const tokens = new Map()
postcss.parse(css).walkRules((rule) => {
  if (rule.selector !== ":root" && rule.selector !== ".dark") return
  rule.walkDecls(/^--/, ({ prop, value }) => tokens.set(prop, value))
})
const theme = `:root { ${[...tokens].map(([name, value]) => `${name}: ${value};`).join("\n")} }`
const html = template
  .replace("/* __THEME__ */", theme)
  .replace("__FONT__", `data:font/ttf;base64,${font}`)
  .replace("__LOGO__", `data:image/svg+xml;base64,${logo}`)
const output =
  process.argv[2] || fileURLToPath(new URL("app/opengraph-image.png", root))
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  })
  // All assets are embedded, so exporting does not require network access.
  await page.route("**/*", (route) => route.abort())
  await page.setContent(html)
  await page.evaluate(() => document.fonts.ready)
  await page.locator(".card").screenshot({ path: output })
  console.log(`Social preview exported to ${output} (1200 × 630).`)
} finally {
  await browser.close()
}
