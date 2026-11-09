import { build } from "tsup"
import { chmod, readFile, copyFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const requested = process.argv[2]
if (requested && !["sdk", "cli", "react"].includes(requested))
  throw new Error("Expected sdk, cli or react")
for (const name of requested ? [requested] : ["sdk", "cli", "react"]) {
  const directory = join(root, "packages", name)
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8")
  )
  const entries =
    name === "sdk"
      ? ["index", "otel", "context", "openai", "contracts", "agents"]
      : name === "react"
        ? ["index", "server"]
        : ["index", "datool"]
  await build({
    entry: Object.fromEntries(
      entries.map((entry) => [
        entry,
        join(
          directory,
          "src",
          `${entry}.${name === "react" && entry === "index" ? "tsx" : "ts"}`
        ),
      ])
    ),
    outDir: join(directory, "dist"),
    tsconfig: join(root, "tsconfig.json"),
    format: ["esm"],
    platform: "node",
    target: "node22",
    splitting: false,
    clean: true,
    sourcemap: false,
    dts: { compilerOptions: { incremental: false } },
    external: [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ],
    define: {
      "process.env.DATOOL_CLI_VERSION": JSON.stringify(manifest.version),
    },
  })
  if (name === "react") {
    const entry = join(directory, "dist", "index.js")
    await writeFile(
      entry,
      '"use client";\n' + (await readFile(entry, "utf8"))
    )
    await copyFile(
      join(directory, "src", "styles.css"),
      join(directory, "dist", "styles.css")
    )
  }
  if (name === "cli") await chmod(join(directory, "dist", "datool.js"), 0o755)
}
