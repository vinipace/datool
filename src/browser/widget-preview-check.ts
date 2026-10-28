import type {
  WidgetDiagnostic,
  WidgetPreviewReport,
} from "../lib/build/widget-validation"

/** Observe a committed render inside the existing iframe, never on the server. */
export async function checkWidgetPreview(
  root: HTMLElement,
  allowEmpty: boolean
): Promise<WidgetPreviewReport> {
  const images = Array.from(root.querySelectorAll("img"))
  await Promise.all(
    images.map(
      (image) =>
        new Promise<void>((resolve) => {
          if (image.complete) return resolve()
          // Offscreen authoring previews still need to exercise lazy image loading.
          image.loading = "eager"
          const finish = () => {
            clearTimeout(timer)
            image.removeEventListener("load", finish)
            image.removeEventListener("error", finish)
            resolve()
          }
          const timer = setTimeout(finish, 5000)
          image.addEventListener("load", finish)
          image.addEventListener("error", finish)
        })
    )
  )
  // The host may run this check offscreen. Animation frames are throttled for
  // cross-origin offscreen iframes; layout reads below flush committed styles.
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const visible = (element: Element) => {
    const style = getComputedStyle(element)
    return (
      element.getClientRects().length > 0 &&
      style.visibility !== "hidden" &&
      style.display !== "none"
    )
  }
  const diagnostics: WidgetDiagnostic[] = []
  const missingVariables = new Set<string>()
  for (const element of root.querySelectorAll<HTMLElement>("[style]")) {
    if (!visible(element)) continue
    const computed = getComputedStyle(element)
    for (const property of Array.from(element.style)) {
      // Only direct references without fallbacks: nested fallback expressions
      // can legitimately contain unused variables that are not defined.
      const match = /^var\(\s*(--[\w-]+)\s*\)$/.exec(
        element.style.getPropertyValue(property).trim()
      )
      if (match && !computed.getPropertyValue(match[1]).trim())
        missingVariables.add(match[1])
    }
  }
  for (const name of missingVariables)
    diagnostics.push({
      code: "undefined_style_variable",
      severity: "error",
      message: `Style variable ${name} is undefined. Reuse a themeProperties token from build_get_widget_components, or define a local variable.`,
    })
  const text = root.innerText.trim().slice(0, 4000)
  const shown = images.filter(visible)
  for (const image of shown) {
    if (!image.complete || !image.naturalWidth)
      diagnostics.push({
        code: "image_failed",
        severity: "error",
        message:
          `Image did not load: ${image.getAttribute("alt") || image.getAttribute("src") || "unnamed image"}`.slice(
            0,
            500
          ),
      })
  }
  const controls = Array.from(
    root.querySelectorAll("input,button,select,textarea,svg,canvas")
  ).filter(visible)
  if (
    !allowEmpty &&
    !text &&
    !shown.some((image) => image.naturalWidth > 0) &&
    !controls.length
  )
    diagnostics.push({
      code: "empty_preview",
      severity: "error",
      message:
        "The widget rendered no visible content. Supply representative default data, render an empty-state message, or explicitly allow an intentional empty preview.",
    })
  if (
    document.documentElement.scrollWidth >
    document.documentElement.clientWidth + 1
  )
    diagnostics.push({
      code: "horizontal_overflow",
      severity: "error",
      message:
        "The widget overflows the preview viewport. Keep scrolling within the intended container.",
    })
  return {
    rendered: true,
    schemaValidated: true,
    valid: !diagnostics.some((item) => item.severity === "error"),
    diagnostics,
    text,
    imageCount: shown.length,
    width: document.documentElement.clientWidth,
  }
}
