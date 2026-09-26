import {
  createLibraryEntry,
  moveLibraryEntry,
} from "@/src/lib/tracer/dataset-library"
import { api, readJson } from "@/src/server/tracer/http"
import { validation } from "@/src/server/tracer/errors"
import { parseId, parseListLimit } from "@/src/server/tracer/validation"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"

export async function GET(request: Request) {
  return api(request, (service) => {
    const params = new URL(request.url).searchParams
    const scope = params.get("scope")
    if (scope && scope !== "tree")
      throw validation("Unknown dataset library scope.")
    const folderId = params.get("folderId")
    const filter = params.get("filter")
    if (filter && filter.length > 200)
      throw validation("Search must be at most 200 characters.")
    return service.listDatasetLibrary({
      ...(scope === "tree" ? { scope: "tree" as const } : {}),
      folderId: folderId ? parseId(folderId, "folder id") : null,
      filter,
      cursor: params.get("cursor"),
      limit: parseListLimit(params.get("limit")),
    })
  })
}

export async function POST(request: Request) {
  return api(
    request,
    async (service) => {
      const parsed = createLibraryEntry.safeParse(await readJson(request))
      if (!parsed.success) throw validation(parsed.error.issues[0].message)
      return service.createDatasetLibraryEntry(parsed.data)
    },
    { mutation: true }
  )
}

export async function PATCH(request: Request) {
  return api(
    request,
    async (service) => {
      const parsed = moveLibraryEntry.safeParse(await readJson(request))
      if (!parsed.success) throw validation(parsed.error.issues[0].message)
      return service.moveDatasetLibraryEntry(parsed.data)
    },
    { mutation: true }
  )
}
