import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type {
  Browser,
  BrowserContext,
  FrameLocator,
  Locator,
  Page,
} from "playwright"
import type { WidgetDefinition } from "@/src/lib/build/contracts"
import type { JourneyStep } from "@/src/lib/build/agent-journey"
import { widgetAsCode } from "@/src/lib/build/widget-code"
import {
  widgetFrameDocument,
  widgetThemeProperties,
} from "@/src/lib/build/widget-frame"
import { publicHttpRequest } from "../http"

const origin = "https://widget-tests.invalid"
const assets = new Map([
  ["/widget-runtime.js", ["widget-runtime.js", "text/javascript"]],
  ["/widget-runtime.css", ["widget-runtime.css", "text/css"]],
  ["/theme.css", ["trace-views/theme.css", "text/css"]],
])
export type JourneyBrowserAction = {
  functionName: string
  input: Record<string, unknown>
  label?: string
}

let activeBrowsers = 0
const browserWaiters = new Set<() => void>()
async function acquireBrowser(signal: AbortSignal) {
  while (activeBrowsers >= 2) {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const wake = () => {
        cleanup()
        resolve()
      }
      const abort = () => {
        cleanup()
        reject(new Error("Journey cancelled."))
      }
      const cleanup = () => {
        browserWaiters.delete(wake)
        signal.removeEventListener("abort", abort)
      }
      browserWaiters.add(wake)
      signal.addEventListener("abort", abort, { once: true })
      if (signal.aborted) abort()
    })
  }
  signal.throwIfAborted()
  activeBrowsers++
  return () => {
    activeBrowsers--
    for (const wake of [...browserWaiters]) wake()
  }
}

/** Runs the shipped opaque widget runtime without application cookies or action/network credentials. */
export class JourneyBrowser {
  private browser?: Browser
  private context?: BrowserContext
  private page?: Page
  private failure: string | null = null
  private lastText = ""
  private release?: () => void
  private abort = () => {
    void this.close()
  }

  constructor(
    private readonly width: number,
    private readonly signal: AbortSignal,
    private readonly locale = "en"
  ) {}

  async open() {
    if (this.signal.aborted) throw new Error("Journey cancelled.")
    this.release = await acquireBrowser(this.signal)
    const { chromium } = await import("playwright")
    this.browser = await chromium.launch({
      headless: true,
      timeout: 10_000,
      args: [
        "--js-flags=--max-old-space-size=128",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    })
    this.signal.addEventListener("abort", this.abort, { once: true })
    if (this.signal.aborted) {
      await this.close()
      throw new Error("Journey cancelled.")
    }
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: 900 },
      locale: this.locale,
      serviceWorkers: "block",
      acceptDownloads: false,
    })
    await this.context.addInitScript(() => {
      for (const key of [
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "WebSocket",
        "WebTransport",
        "EventSource",
        "Worker",
        "SharedWorker",
      ])
        Object.defineProperty(window, key, {
          value: undefined,
          configurable: false,
        })
    })
    await this.context.routeWebSocket("**/*", (socket) => socket.close())
    let imageRequests = 0
    let imageBytes = 0
    await this.context.route("**/*", async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      try {
        if (url.origin === origin) {
          if (url.pathname === "/")
            return await route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><html lang="en"><head><link rel="stylesheet" href="/theme.css"></head><body><p id="answer"></p></body></html>',
            })
          const asset = assets.get(url.pathname)
          if (asset)
            return await route.fulfill({
              contentType: asset[1],
              body: await readFile(join(process.cwd(), "public", asset[0])),
            })
          if (
            /^\/widget-template-assets\/[a-zA-Z0-9_-]+\.webp$/.test(
              url.pathname
            )
          )
            return await route.fulfill({
              contentType: "image/webp",
              body: await readFile(join(process.cwd(), "public", url.pathname)),
            })
        }
        // Every external image is fetched through the existing DNS-pinned public
        // transport. Redirects, private destinations, navigation and all other
        // browser network requests are blocked, including after a link click.
        if (
          request.resourceType() === "image" &&
          url.protocol === "https:" &&
          ++imageRequests <= 40 &&
          imageBytes < 16 * 1024 * 1024
        ) {
          const response = await publicHttpRequest(url.toString(), {
            timeoutMs: 8_000,
            maxResponseBytes: 5 * 1024 * 1024,
            signal: this.signal,
          })
          const contentType = response.headers.get("content-type") ?? ""
          imageBytes += Buffer.byteLength(response.body)
          if (
            response.status >= 200 &&
            response.status < 300 &&
            /^image\/(png|jpeg|webp|gif|avif)(;|$)/i.test(contentType)
          )
            return await route.fulfill({
              status: response.status,
              contentType,
              body: Buffer.from(response.body),
            })
        }
      } catch {
        /* A blocked/missing image is surfaced by the render check below. */
      }
      await route.abort().catch(() => {})
    })
    this.page = await this.context.newPage()
    this.page.setDefaultTimeout(4_000)
    this.context.on("page", (page) => {
      if (page !== this.page) void page.close()
    })
    await this.page.goto(origin)
  }

  async show(
    text: string,
    widget?: { definition: WidgetDefinition; data: Record<string, unknown> }
  ) {
    if (!this.page) throw new Error("Journey browser is unavailable.")
    this.lastText = text
    this.failure = null
    const definition = widget ? widgetAsCode(widget.definition) : null
    const observed = await this.page.evaluate(
      async (payload: string) => {
        const { text, definition, data, source, properties, locale } =
          JSON.parse(payload) as {
            text: string
            definition: {
              code: string
              schemaCode?: string
              functions: Array<{ name: string }>
              translations?: Record<string, Record<string, string>>
            } | null
            data: Record<string, unknown>
            source: string
            properties: string[]
            locale: string
          }
        document.querySelector("iframe")?.remove()
        document.getElementById("answer")!.textContent = text
        const state = window as unknown as {
          journeyActions: JourneyBrowserAction[]
          journeyError: string | null
          journeyRequest: number
          journeyCleanup?: () => void
        }
        state.journeyCleanup?.()
        state.journeyActions = []
        state.journeyError = null
        state.journeyRequest = (state.journeyRequest ?? 0) + 1
        const requestId = state.journeyRequest
        if (!definition) return null
        const theme = Object.fromEntries(
          properties.map((name) => [
            name,
            getComputedStyle(document.documentElement)
              .getPropertyValue(name)
              .trim(),
          ])
        )
        const frame = document.createElement("iframe")
        frame.title = "Widget content"
        frame.setAttribute("sandbox", "allow-scripts")
        Object.assign(frame.style, {
          width: "100%",
          height: "800px",
          border: "0",
        })
        return await new Promise<string | null>((resolve) => {
          const timer = setTimeout(
            () => finish("The widget did not complete rendering."),
            10_000
          )
          function finish(error: string | null) {
            clearTimeout(timer)
            resolve(error)
          }
          function receive(event: MessageEvent) {
            if (event.source !== frame.contentWindow) return
            const value = event.data
            if (value?.type === "widget-ready")
              frame.contentWindow!.postMessage(
                {
                  type: "render-widget",
                  requestId,
                  code: definition!.code,
                  schemaCode: definition!.schemaCode,
                  data,
                  functions: definition!.functions.map((fn) => fn.name),
                  enabled: true,
                  locale,
                  translations: definition!.translations,
                  theme,
                  validatePreview: { allowEmpty: false },
                },
                "*"
              )
            if (value?.requestId !== requestId) return
            if (
              value.type === "widget-action" &&
              definition!.functions.some((fn) => fn.name === value.functionName)
            ) {
              if (
                JSON.stringify(value).length > 65_536 ||
                state.journeyActions.length >= 10 ||
                !value.input ||
                typeof value.input !== "object" ||
                Array.isArray(value.input)
              ) {
                state.journeyError =
                  "The widget submitted an invalid or oversized interaction."
                return
              }
              state.journeyActions.push(value)
            }
            if (value.type === "widget-status" && value.error) {
              state.journeyError = String(value.error)
              finish(state.journeyError)
            }
            if (value.type === "widget-preview-result") {
              const errors =
                value.report?.diagnostics?.filter(
                  (item: { severity: string }) => item.severity === "error"
                ) ?? []
              const error =
                errors
                  .map((item: { message: string }) => item.message)
                  .join("; ") || null
              state.journeyError = error
              finish(error)
            }
          }
          window.addEventListener("message", receive)
          state.journeyCleanup = () =>
            window.removeEventListener("message", receive)
          frame.srcdoc = source
          document.body.append(frame)
        })
      },
      JSON.stringify({
        text,
        definition,
        data: widget?.data,
        source: widgetFrameDocument(origin),
        properties: widgetThemeProperties,
        locale: this.locale,
      })
    )
    this.failure = observed
    if (observed) throw new Error(observed.slice(0, 2_000))
  }

  private async field(name: string): Promise<Locator> {
    const frame = this.frame()
    const labelled = frame.getByLabel(name, { exact: true })
    return (await labelled.count())
      ? labelled
      : frame.getByRole("textbox", { name, exact: true })
  }

  private frame(): FrameLocator {
    if (!this.page) throw new Error("Journey browser is unavailable.")
    return this.page.frameLocator('iframe[title="Widget content"]')
  }

  async step(
    step: Exclude<JourneyStep, { type: "message" | "expect_action" }>
  ) {
    if (this.signal.aborted) throw new Error("Journey cancelled.")
    if (this.failure) throw new Error(this.failure)
    const frame = this.frame()
    switch (step.type) {
      case "click": {
        const control = frame.getByRole(step.role, {
          name: step.name,
          exact: true,
        })
        if (step.role === "link") {
          // Observe destinations without opening WhatsApp, sending messages,
          // navigating to a merchant, or consuming an external action.
          if (!(await control.getAttribute("href")))
            throw new Error(`Link ${step.name} has no destination.`)
        } else await control.click()
        break
      }
      case "fill":
        await (await this.field(step.name)).fill(step.value)
        break
      case "select":
        await frame
          .getByLabel(step.name, { exact: true })
          .selectOption(step.value)
        break
      case "check":
        await frame
          .getByRole("checkbox", { name: step.name, exact: true })
          .setChecked(step.checked)
        break
      case "expect_text": {
        if (!this.lastText.includes(step.text))
          await frame
            .getByText(step.text, { exact: false })
            .first()
            .waitFor({ state: "visible" })
        break
      }
      case "expect_value": {
        if ((await (await this.field(step.name)).inputValue()) !== step.value)
          throw new Error(`Unexpected value for ${step.name}.`)
        break
      }
      case "expect_selected": {
        const control = frame.getByRole("button", {
          name: step.name,
          exact: true,
        })
        if (
          (await control.getAttribute("aria-pressed")) !== String(step.selected)
        )
          throw new Error(`Unexpected selection for ${step.name}.`)
        break
      }
      case "expect_link": {
        const href = await frame
          .getByRole("link", { name: step.name, exact: true })
          .getAttribute("href")
        if (!href) throw new Error(`Link ${step.name} has no destination.`)
        if (step.href && href !== step.href)
          throw new Error(`Unexpected destination for ${step.name}.`)
        if (
          step.message !== undefined &&
          !(new URL(href).searchParams.get("text") ?? "").includes(step.message)
        )
          throw new Error(
            `The handoff message is missing the expected summary.`
          )
        break
      }
    }
    await this.page!.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    const error = await this.page!.evaluate(
      () => (window as unknown as { journeyError: string | null }).journeyError
    )
    if (error) throw new Error(error.slice(0, 2_000))
  }

  async actions(): Promise<JourneyBrowserAction[]> {
    return this.page!.evaluate(() => {
      const state = window as unknown as {
        journeyActions: JourneyBrowserAction[]
      }
      return state.journeyActions.splice(0)
    })
  }

  async close() {
    this.signal.removeEventListener("abort", this.abort)
    await this.browser?.close().catch(() => {})
    this.browser = undefined
    this.release?.()
    this.release = undefined
  }
}
