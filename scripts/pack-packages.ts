import { mkdir, readFile } from "node:fs/promises"
import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { join } from "node:path"

const root = fileURLToPath(new URL("..", import.meta.url))
const destination = join(root, "artifacts", "npm")
await mkdir(destination, { recursive: true })
for (const name of ["sdk", "cli"]) {
  const cwd = join(root, "packages", name)
  const [packed] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", destination],
      { cwd, encoding: "utf8" }
    )
  )
  for (const file of packed.files) {
    if (
      !/^(dist\/[^/]+\.(js|d\.ts)|package\.json|README\.md|LICENSE)$/.test(
        file.path
      )
    ) {
      throw new Error(`Unexpected package file: ${file.path}`)
    }
    if (file.path.startsWith("dist/")) {
      const content = await readFile(join(cwd, file.path), "utf8")
      if (/(?:from|import\()\s*["'](?:@\/|\.\.\/\.\.\/)/.test(content))
        throw new Error(`Repository import in ${file.path}`)
    }
  }
  console.info(
    `${packed.name}@${packed.version}: ${packed.files.length} files, ${packed.unpackedSize} bytes → ${packed.filename}`
  )
}
