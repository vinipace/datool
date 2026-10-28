import { widgetDefinitionSchema } from "./contracts"
import { widgetAsCode } from "./widget-code"
import { widgetFrameDocument, widgetThemeProperties } from "./widget-frame"
import {
  widgetPreviewReportSchema,
  type WidgetPreviewReport,
} from "./widget-validation"

/** Read-only rendering check. No action dispatch, credentials, or backend execution. */
export async function validateWidgetPreview(
  input: unknown,
  options: {
    state?: string
    allowEmpty?: boolean
    width?: number
    themeElement?: Element
    signal?: AbortSignal
  } = {}
): Promise<WidgetPreviewReport> {
  const definition = widgetAsCode(widgetDefinitionSchema.parse(input))
  const state = options.state ?? "default"
  if (!Object.hasOwn(definition.states, state))
    throw new Error(`Missing ${state} preview state`)
  const width = options.width ?? 360
  if (!Number.isInteger(width) || width < 240 || width > 1440)
    throw new Error("Preview width must be 240–1440 pixels")
  const style = getComputedStyle(
    options.themeElement ?? document.documentElement
  )
  const theme = Object.fromEntries(
    widgetThemeProperties.map((name) => [
      name,
      style.getPropertyValue(name).trim(),
    ])
  )
  theme.colorScheme = style.colorScheme
  const frame = document.createElement("iframe")
  frame.title = "Widget validation sandbox"
  frame.setAttribute("sandbox", "allow-scripts")
  frame.setAttribute("aria-hidden", "true")
  frame.tabIndex = -1
  Object.assign(frame.style, {
    position: "fixed",
    left: "-10000px",
    top: "0",
    width: `${width}px`,
    height: "900px",
    border: "0",
    pointerEvents: "none",
  })
  return new Promise((resolve, reject) => {
    const requestId = 1
    let sent = false
    const cleanup = () => {
      clearTimeout(timer)
      window.removeEventListener("message", receive)
      options.signal?.removeEventListener("abort", abort)
      frame.remove()
    }
    const abort = () => {
      cleanup()
      reject(new Error("Widget preview cancelled"))
    }
    const finish = (report: WidgetPreviewReport) => {
      cleanup()
      resolve(report)
    }
    const timer = setTimeout(
      () =>
        finish({
          rendered: false,
          valid: false,
          schemaValidated: false,
          diagnostics: [
            {
              code: "preview_timeout",
              severity: "error",
              message: sent
                ? "The widget did not complete rendering within 30 seconds."
                : "The widget runtime did not load within 30 seconds. Check the runtime asset and browser policy.",
            },
          ],
        }),
      30000
    )
    function receive(event: MessageEvent) {
      if (event.source !== frame.contentWindow) return
      const value = event.data
      if (value?.type === "widget-ready" && !sent) {
        sent = true
        frame.contentWindow?.postMessage(
          {
            type: "render-widget",
            requestId,
            code: definition.code,
            schemaCode: definition.schemaCode,
            data: definition.states[state],
            functions: [],
            enabled: false,
            theme,
            validatePreview: { allowEmpty: options.allowEmpty ?? false },
          },
          "*"
        )
      } else if (
        value?.requestId === requestId &&
        value.type === "widget-status" &&
        typeof value.error === "string"
      ) {
        finish({
          rendered: false,
          valid: false,
          schemaValidated: false,
          diagnostics: [
            {
              code: "render_error",
              severity: "error",
              message: value.error.slice(0, 2000),
            },
          ],
        })
      } else if (
        value?.requestId === requestId &&
        value.type === "widget-preview-result"
      ) {
        // Reports are untrusted widget observations, not permission or publication receipts.
        const report = widgetPreviewReportSchema.safeParse(value.report)
        finish(
          report.success
            ? report.data
            : {
                rendered: false,
                valid: false,
                schemaValidated: false,
                diagnostics: [
                  {
                    code: "invalid_preview_report",
                    severity: "error",
                    message: "The widget returned a malformed preview report.",
                  },
                ],
              }
        )
      }
    }
    window.addEventListener("message", receive)
    options.signal?.addEventListener("abort", abort, { once: true })
    if (options.signal?.aborted) return abort()
    frame.srcdoc = widgetFrameDocument(window.location.origin)
    document.body.append(frame)
  })
}
