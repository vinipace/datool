import { useQuery } from "@tanstack/react-query"
import { auth, assertApiUrl } from "./auth"
import { queryClient } from "./query"
import { reportError } from "./diagnostics"
export function useSession() {
  return useQuery({ queryKey: ["session"], networkMode: "always", retry: false, queryFn: async ({ signal }) => {
    assertApiUrl()
    const result = await auth.getSession({ query: { disableCookieCache: true },
      fetchOptions: { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) } })
    if (result.error && result.error.status !== 401) throw Object.assign(new Error(result.error.message ?? "Could not check your session."), { code: result.error.code, status: result.error.status })
    const cached = queryClient.getQueryData<{ user: { id: string } } | null>(["session"])
    if (cached?.user.id && cached.user.id !== result.data?.user.id) {
      if (!result.data) {
        queryClient.setQueryData(["auth-notice"], "Your session ended. Sign in again to continue. Your queued replies are still saved on this device.")
        reportError("session", { code: "SESSION_MISSING" })
      }
      queryClient.removeQueries({ predicate: query => !["session", "auth-notice"].includes(String(query.queryKey[0])) })
    }
    if (result.data) queryClient.removeQueries({ queryKey: ["auth-notice"], exact: true })
    // Persist only the offline identity, never Better Auth's session token.
    return result.data ? { user: { id: result.data.user.id, name: result.data.user.name, email: result.data.user.email, image: result.data.user.image } } : null
  }, staleTime: 60_000, refetchInterval: 60_000 })
}
