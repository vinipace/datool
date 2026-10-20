import { build } from "esbuild"
import postcss from "postcss"
import tailwind from "@tailwindcss/postcss"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { resolve } from "node:path"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const bundle = await build({
  absWorkingDir: root,
  entryPoints: ["packages/chatgpt-trace-explorer/src/main.tsx"],
  outfile: "trace-explorer.js",
  bundle: true,
  minify: true,
  write: false,
  platform: "browser",
  format: "esm",
  target: "es2022",
  jsx: "automatic",
  // Optional code editors are not mounted by the read-only explorer. Keep
  // their app stylesheet from injecting font requests into the embedded host.
  plugins: [
    {
      name: "omit-unused-editor-styles",
      setup(build) {
        build.onLoad({ filter: /monaco-editor[\/\\].*\.css$/ }, () => ({
          contents: "",
          loader: "css",
        }))
      },
    },
  ],
  tsconfig: "tsconfig.json",
  define: { "process.env.NODE_ENV": '"production"' },
})
// Consume the central product palette and shared utilities without building a Next page shell.
const theme = (
  await readFile(resolve(root, "app/globals.css"), "utf8")
).replace(
  '@import "tailwindcss";',
  '@import "tailwindcss" source(none);\n@source "../components/plugins";\n@source "../components/ui";\n@source "../components/tracer";'
)
const style = await postcss([tailwind({ base: root, optimize: true })]).process(
  theme,
  { from: resolve(root, "app/globals.css") }
)
const javascript = bundle.outputFiles
  .find((file) => file.path.endsWith(".js"))
  .text // HTML comment openers can leave an inline script in the double-escaped
  // parser state when dependencies contain their own <script> strings.
  .replace(/<!--/g, "\\x3c!--")
  .replace(/<\/script/gi, "<\\/script")
const css = (
  style.css +
  bundle.outputFiles
    .filter((file) => file.path.endsWith(".css"))
    .map((file) => file.text)
    .join("\n")
).replace(/<\/style/gi, "<\\/style")
const html = `<!doctype html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Datool Trace Explorer</title><style>${css}\nhtml,body,#root{margin:0;min-width:0;min-height:100%;}body{background:var(--background);color:var(--foreground);font-family:ui-sans-serif,system-ui,sans-serif;}</style></head><body><div id="root"></div><script type="module">${javascript}</script></body></html>`
await mkdir(resolve(root, "public/mcp-apps"), { recursive: true })
await writeFile(resolve(root, "public/mcp-apps/trace-explorer.html"), html)
console.log(
  `Built isolated Trace Explorer (${Math.round(Buffer.byteLength(html) / 1024)} KiB).`
)
