/** Actual application handlers shared by disposable HTTP verification servers. */
export async function refreshRoutes() {
  const [traces, overview, scores, sessions, session, evals, run, compare, groups] = await Promise.all([
    import("../../app/api/traces/route"), import("../../app/api/traces/[id]/overview/route"), import("../../app/api/traces/[id]/scores/route"),
    import("../../app/api/sessions/route"), import("../../app/api/sessions/[id]/route"), import("../../app/api/evals/route"),
    import("../../app/api/evals/[id]/route"), import("../../app/api/evals/compare/route"), import("../../app/api/evals/groups/route"),
  ])
  return async (request: Request) => {
    const path = new URL(request.url).pathname
    if (path === "/api/traces") return traces.GET(request)
    if (path === "/api/sessions") return request.method === "POST" ? sessions.POST(request) : sessions.GET(request)
    if (path === "/api/evals") return evals.GET(request)
    if (path === "/api/evals/compare") return compare.GET(request)
    if (path === "/api/evals/groups") return groups.GET(request)
    const parts = path.split("/")
    const context = { params: Promise.resolve({ id: decodeURIComponent(parts[3] ?? "") }) }
    if (parts[2] === "sessions" && parts.length === 4) return session.GET(request, context)
    if (parts[2] === "evals" && parts.length === 4) return run.GET(request, context)
    if (parts[2] === "traces" && parts[4] === "overview") return overview.GET(request, context)
    if (parts[2] === "traces" && parts[4] === "scores") return scores.GET(request, context)
    return new Response(null, { status: 404 })
  }
}
