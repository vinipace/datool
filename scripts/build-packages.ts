import { build } from "tsup"
import { chmod, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const requested = process.argv[2]
if (requested && !["sdk", "cli"].includes(requested))
  throw new Error("Expected sdk or cli")
for (const name of requested ? [requested] : ["sdk", "cli"]) {
  const directory = join(root, "packages", name)
  const manifest = JSON.parse(
    await readFile(join(directory, "package.json"), "utf8")
  )
  const entries =
    name === "sdk"
      ? ["index", "otel", "context", "openai", "contracts"]
      : ["index", "datool"]
  await build({
    entry: Object.fromEntries(
      entries.map((entry) => [entry, join(directory, "src", `${entry}.ts`)])
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
    external: Object.keys(manifest.dependencies),
    define: {
      "process.env.DATOOL_CLI_VERSION": JSON.stringify(manifest.version),
    },
  })
  if (name === "cli") await chmod(join(directory, "dist", "datool.js"), 0o755)
}
