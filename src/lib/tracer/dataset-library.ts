import { z } from "zod"

/** Dataset names remain full paths, including for resource import/export keys. */
export const datasetPath = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (value) =>
      value
        .split("/")
        .every(
          (part) =>
            part.trim() === part &&
            part.length > 0 &&
            part !== "." &&
            part !== ".."
        ) &&
      [...value].every(
        (char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127
      ),
    "Use non-empty folder names separated by /, without . or .. segments."
  )

export const createLibraryEntry = z
  .object({
    kind: z.enum(["dataset", "folder"]),
    name: datasetPath,
    description: z.string().trim().max(4_000).optional(),
    folderId: z.string().min(1).max(128).nullable().default(null),
  })
  .strict()

/** A final slash creates a folder; otherwise the final segment is a dataset. */
export const datasetEntryPath = z
  .string()
  .trim()
  .transform((value) => ({
    kind: value.endsWith("/") ? ("folder" as const) : ("dataset" as const),
    name: value.endsWith("/") ? value.slice(0, -1) : value,
  }))
  .pipe(createLibraryEntry)

export const moveLibraryEntry = z
  .object({
    kind: z.enum(["dataset", "folder"]),
    id: z.string().min(1).max(128),
    folderId: z.string().min(1).max(128).nullable(),
  })
  .strict()

export type DatasetLibraryEntry = {
  id: string
  kind: "dataset" | "folder"
  name: string
  description: string | null
  itemCount: number | null
  createdAt: string
  updatedAt: string
}
export type CreatedLibraryEntry = DatasetLibraryEntry & {
  folders: DatasetLibraryEntry[]
}

export type DatasetLibraryPage = {
  items: DatasetLibraryEntry[]
  nextCursor: string | null
}
export type CreateLibraryEntry = z.infer<typeof createLibraryEntry>
export type MoveLibraryEntry = z.infer<typeof moveLibraryEntry>

export const datasetLeafName = (path: string) =>
  path.slice(path.lastIndexOf("/") + 1)
export const datasetParentPath = (path: string) =>
  path.slice(0, Math.max(0, path.lastIndexOf("/")))
