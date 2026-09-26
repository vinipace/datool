import { readFile, writeFile, rename } from "node:fs/promises"
import { createHash, randomUUID } from "node:crypto"
import { resolve } from "node:path"
import {
  resourceDocumentSchema,
  canonicalJson,
} from "../src/lib/tracer/resource-document"
import { appRequest } from "./request"
const digest = (value: unknown) =>
  createHash("sha256").update(canonicalJson(value)).digest("hex")
async function optionalJson(path: string) {
  try {
    return JSON.parse(await readFile(path, "utf8"))
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e
    return null
  }
}
async function atomic(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2) + "\n", {
    mode: 0o600,
  })
  await rename(temporary, path)
}
export async function resourcesCommand(args: string[]) {
  const [resource, action, target] = args
  const option = (name: string) => {
    const i = args.indexOf(name)
    return i < 0 ? undefined : args[i + 1]
  }
  if (!target || !["push", "pull"].includes(action))
    throw new Error(
      "Usage: datool datasets|scorers push <file.json> [--dry-run] or pull <key> --out <file.json>"
    )
  const origin = (
    option("--datool") ??
    process.env.DATOOL_BASE_URL ?? process.env.DATOOL_URL ??
    "http://127.0.0.1:3000"
  ).replace(/\/$/, "")
  const projectId = process.env.DATOOL_PROJECT_ID?.trim()
  if (!projectId) throw new Error("Set DATOOL_PROJECT_ID or pass --project <id>.")
  const kind = resource === "datasets" ? "dataset" : "scorer"
  const filename = action === "push" ? target : option("--out")
  if (!filename) throw new Error("pull requires --out <file.json>")
  const file = resolve(filename)
  const sidecar = `${file}.datool-sync.json`
  const base = await optionalJson(sidecar)
  const local = await optionalJson(file)
  if (action === "push") {
    const document = resourceDocumentSchema.parse(local)
    if (document.kind !== kind) throw new Error("Wrong resource kind")
    const matchingBase =
      base?.origin === origin &&
      base?.projectId === projectId &&
      base?.key === document.key &&
      base?.kind === kind
    const result = await appRequest<{
      revision: string
      conflict: boolean
      changes: unknown[]
    }>(origin, "/api/resources", {
      document,
      dryRun: args.includes("--dry-run"),
      ...(matchingBase ? { expectedRevision: base.revision } : {}),
    })
    if (!args.includes("--dry-run"))
      await atomic(sidecar, {
        origin,
        projectId,
        kind,
        key: document.key,
        revision: result.revision,
        localHash: digest(local),
      })
    console.info(JSON.stringify(result, null, 2))
  } else {
    if (
      local &&
      (!base || base.localHash !== digest(local)) &&
      !args.includes("--replace")
    )
      throw new Error(
        "Local file has unsynced changes. Choose another --out path or use --replace."
      )
    const result = await appRequest<{ document: unknown; revision: string }>(
      origin,
      `/api/resources?kind=${kind}&key=${encodeURIComponent(target)}`
    )
    await atomic(file, result.document)
    await atomic(sidecar, {
      origin,
      projectId,
      kind,
      key: target,
      revision: result.revision,
      localHash: digest(result.document),
    })
    console.info(`Pulled ${kind} ${target} to ${file}`)
  }
}
