/** Project pages are addressed by the active organization and project slug. */
export function workspacePrefix(pathname: string) {
  return pathname.match(/^(\/p\/[^/]+)(?:\/|$)/)?.[1]
    ?? null
}

export function currentProjectScope() {
  if (typeof document === "undefined") return null
  const scope = document.querySelector<HTMLElement>("[data-project-id][data-project-prefix]")
  if (!scope || workspacePrefix(window.location.pathname) !== scope.dataset.projectPrefix) return null
  return { projectId: scope.dataset.projectId!, organizationId: scope.dataset.organizationId! }
}

export function projectFetch(input: string, init?: RequestInit, boundProjectId?: string) {
  const headers = new Headers(init?.headers)
  const scope = currentProjectScope()
  const projectId = boundProjectId ?? scope?.projectId
  if (projectId) headers.set("x-project-id", projectId)
  return fetch(input, { ...init, headers })
}

/** Only same-origin workspace destinations may survive sign-in and selection. */
export function workspaceReturnPath(value: string | null | undefined, fallback = "/") {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("/..")) return fallback
  try {
    const url = new URL(value, "https://workspace.invalid")
    if (url.origin !== "https://workspace.invalid") return fallback
    return `${url.pathname}${url.search}${url.hash}`
  } catch {
    return fallback
  }
}
