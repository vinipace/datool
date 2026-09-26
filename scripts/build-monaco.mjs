import { build } from "bun"
import { mkdir, copyFile } from "node:fs/promises"

// Keep Monaco and its language services local, including in offline workspaces.
await mkdir("public/monaco", { recursive: true })
for (const [name, entry] of Object.entries({
  "editor.worker": "editor/editor.worker.js",
  "json.worker": "language/json/json.worker.js",
  "ts.worker": "languages/features/typescript/ts.worker.js",
})) {
  const result = await build({
    entrypoints: [`node_modules/monaco-editor/esm/vs/${entry}`],
    outdir: "public/monaco",
    naming: `${name}.js`,
    target: "browser",
    minify: true,
  })
  if (!result.success)
    throw new AggregateError(result.logs, `Could not build ${name}`)
}
await copyFile(
  "node_modules/monaco-editor/LICENSE",
  "public/monaco/LICENSE"
).catch(() =>
  copyFile("node_modules/monaco-editor/LICENSE.txt", "public/monaco/LICENSE")
)
