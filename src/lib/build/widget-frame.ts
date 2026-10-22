/** Shared by customer rendering and authoring checks; keep the sandbox opaque. */
export const widgetThemeProperties = [
  "--color-background",
  "--color-foreground",
  "--color-muted",
  "--color-foreground-muted",
  "--color-border",
  "--color-primary",
  "--color-primary-foreground",
  "--color-ring",
  "--color-destructive",
  "--color-data-series-primary",
]

export function widgetFrameDocument(origin: string) {
  // Only the browser's own HTTP(S) origin is used; never interpolate widget data.
  const url = new URL(origin)
  if (!/^https?:$/.test(url.protocol) || url.origin !== origin)
    throw new Error("Invalid widget runtime origin")
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-eval' ${origin}/widget-runtime.js; style-src 'unsafe-inline' ${origin}/widget-runtime.css; img-src https: data: ${origin}/widget-template-assets/; connect-src 'none'; form-action 'none'; base-uri 'none';"><link rel="stylesheet" href="${origin}/widget-runtime.css"></head><body><div id="root"></div><script src="${origin}/widget-runtime.js"></script></body></html>`
}
