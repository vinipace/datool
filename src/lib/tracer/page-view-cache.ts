import type { CustomView } from "./custom-views"

/** One catalog load per project/resource. Explicit mutations update it in place. */
export function createPageViewCache() {
  const projects = new Map<string, { views: Map<string, CustomView>; lists: Map<string, Promise<void>>; reads: Map<string, Promise<CustomView>> }>()
  const project = (id: string) => {
    let entry = projects.get(id)
    if (!entry) {
      entry = { views: new Map(), lists: new Map(), reads: new Map() }
      projects.set(id, entry)
    }
    return entry
  }
  const remember = (projectId: string, view: CustomView) => {
    const state = project(projectId)
    const previous = state.views.get(view.id)
    if (!previous || previous.revision <= view.revision) state.views.set(view.id, view)
    return state.views.get(view.id)!
  }
  return {
    remember,
    remove(projectId: string, id: string) { project(projectId).views.delete(id) },
    async list(projectId: string, resource: CustomView["resource"], load: () => Promise<CustomView[]>) {
      const state = project(projectId)
      if (!state.lists.has(resource)) {
        state.lists.set(resource, load().then(views => { views.forEach(view => remember(projectId, view)) })
          .catch(error => { state.lists.delete(resource); throw error }))
      }
      await state.lists.get(resource)
      return [...state.views.values()].filter(view => view.resource === resource)
    },
    async get(projectId: string, id: string, load: () => Promise<CustomView>, fresh = false) {
      const state = project(projectId)
      if (fresh) return remember(projectId, await load())
      if (state.views.has(id)) return state.views.get(id)!
      if (!state.reads.has(id)) {
        const read = Promise.allSettled([...state.lists.values()]).then(async () =>
          state.views.get(id) ?? remember(projectId, await load()))
        state.reads.set(id, read)
        void read.finally(() => state.reads.delete(id)).catch(() => {})
      }
      return state.reads.get(id)!
    },
  }
}
