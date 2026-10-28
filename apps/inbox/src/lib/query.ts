import { QueryCache, QueryClient } from "@tanstack/react-query"
import { reportError } from "./diagnostics"
export const queryClient = new QueryClient({ queryCache: new QueryCache({
  onError: (error, query) => reportError(query.queryKey[0] === "session" ? "session" : "api", error),
}), defaultOptions: {
  // Keep below the ~24-day JavaScript timer limit; overflowing it would evict
  // hydrated queries immediately, before offline screens can subscribe.
  queries: { retry: 1, staleTime: 10_000, gcTime: 7 * 24 * 60 * 60_000 }, mutations: { retry: false },
} })
