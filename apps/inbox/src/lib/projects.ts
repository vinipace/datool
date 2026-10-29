import { useInfiniteQuery } from "@tanstack/react-query"
import { api } from "./api"
import type { Page, Project } from "./types"

/** Share the saved project list between the launcher, inbox title and switcher. */
export function useProjects(enabled = true) {
  return useInfiniteQuery({
    queryKey: ["projects"], enabled, staleTime: 60_000, initialPageParam: "",
    queryFn: ({ pageParam, signal }) => api<Page<Project>>(`/api/inbox-mobile/projects?cursor=${encodeURIComponent(pageParam)}`, { signal }),
    getNextPageParam: page => page.nextCursor ?? undefined,
  })
}
