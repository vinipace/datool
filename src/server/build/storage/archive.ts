import { createHash } from "node:crypto"
import { extract, pack } from "tar-stream"
import { z } from "zod"
import { boundedBytes, maxFileBytes } from "./objects"

export const maxDriveBytes = 64 * 1024 * 1024
export const maxArchiveBytes = 80 * 1024 * 1024
export const maxDriveEntries = 10000
export function drivePath(value: string, root = false) {
  const path = value.replace(/^\.\//, "").replace(/\/$/, "")
  if (root && ["", "."].includes(path)) return ""
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    Array.from(path).some((character) => character.charCodeAt(0) < 32) ||
    path.length > 1000 ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Use a relative path inside the drive.")
  return path
}
const entrySchema = z.object({
  path: z.string(),
  type: z.enum(["file", "directory"]),
  hash: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  size: z.number().int().nonnegative().max(maxFileBytes),
  mode: z.number().int().min(0).max(0o777),
})
export const manifestSchema = z.array(entrySchema).max(maxDriveEntries)
export type Manifest = z.infer<typeof manifestSchema>
export function validateManifest(value: unknown): Manifest {
  const entries = manifestSchema.parse(value)
  const paths = new Map<string, Manifest[number]>()
  let size = 0
  for (const entry of entries) {
    drivePath(entry.path)
    if (
      paths.has(entry.path) ||
      (entry.type === "file" && !entry.hash) ||
      (entry.type === "directory" && (entry.hash || entry.size))
    )
      throw new Error("Invalid drive archive.")
    paths.set(entry.path, entry)
    size += entry.size
  }
  if (size > maxDriveBytes)
    throw new Error("The drive exceeds the 64 MiB synchronization limit.")
  for (const entry of entries) {
    const parts = entry.path.split("/")
    for (let i = 1; i < parts.length; i++)
      if (paths.get(parts.slice(0, i).join("/"))?.type !== "directory")
        throw new Error("A drive entry has an invalid parent directory.")
  }
  return entries.sort((a, b) => a.path.localeCompare(b.path))
}
export const fileHash = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex")

/** Archives are decoded as data; they are never extracted onto the server. */
export async function readDriveArchive(bytes: Buffer) {
  if (bytes.length > maxArchiveBytes)
    throw new Error("The drive archive is too large.")
  const parser = extract()
  const manifest: Manifest = []
  const files = new Map<string, Buffer>()
  let total = 0
  parser.on("entry", (header, stream, next) => {
    void (async () => {
      const path = drivePath(header.name, true)
      if (!path && header.type === "directory") {
        stream.resume()
        next()
        return
      }
      if (!path || !["file", "directory"].includes(header.type ?? "file"))
        throw new Error(
          "Object-backed drives support regular files and directories. Keep symlinks and installed dependencies on a local or Modal volume."
        )
      if (header.size! > maxFileBytes || manifest.length >= maxDriveEntries)
        throw new Error("The drive archive exceeds its file limits.")
      const content = await boundedBytes(stream)
      total += content.length
      if (total > maxDriveBytes)
        throw new Error("The drive exceeds the 64 MiB synchronization limit.")
      const type = header.type === "directory" ? "directory" : "file"
      const hash = type === "file" ? fileHash(content) : undefined
      if (hash) files.set(hash, content)
      manifest.push({
        path,
        type,
        hash,
        size: content.length,
        mode: (header.mode ?? 0o600) & 0o777,
      })
      next()
    })().catch((error) => parser.destroy(error))
  })
  await new Promise<void>((resolve, reject) => {
    parser.on("finish", resolve)
    parser.on("error", reject)
    parser.end(bytes)
  })
  return { manifest: validateManifest(manifest), files }
}
export async function writeDriveArchive(
  manifest: Manifest,
  read: (hash: string) => Promise<Buffer>
) {
  const writer = pack()
  const output = boundedBytes(writer, maxArchiveBytes)
  // Ensure every directory exists before its children; strip ownership and special bits.
  try {
    const entries = [...validateManifest(manifest)].sort(
      (a, b) =>
        a.path.split("/").length - b.path.split("/").length ||
        a.path.localeCompare(b.path)
    )
    for (const entry of entries) {
      const bytes =
        entry.type === "file" ? await read(entry.hash!) : Buffer.alloc(0)
      if (
        bytes.length !== entry.size ||
        (entry.hash && fileHash(bytes) !== entry.hash)
      )
        throw new Error("Stored file integrity verification failed.")
      await new Promise<void>((resolve, reject) =>
        writer.entry(
          {
            name: entry.path,
            type: entry.type,
            mode: entry.mode,
            mtime: new Date(0),
            size: bytes.length,
          },
          bytes,
          (error) => (error ? reject(error) : resolve())
        )
      )
    }
    writer.finalize()
    return await output
  } catch (error) {
    writer.destroy(error as Error)
    await output.catch(() => undefined)
    throw error
  }
}
