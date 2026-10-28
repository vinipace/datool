import { fetch } from "expo/fetch"
import { API_URL, assertApiUrl, auth } from "./auth"
import { queryClient } from "./query"
import { reportError } from "./diagnostics"

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly reason?: string) { super(message) }
}
export async function request<T>(path: string, options: RequestInit = {}, projectId?: string): Promise<T> {
  try {
    assertApiUrl()
    const headers = new Headers(options.headers)
    headers.set("Content-Type", "application/json")
    if (process.env.EXPO_OS !== "web" && options.credentials !== "omit") {
      headers.set("Cookie", await auth.getCookie())
      // Native requests have no browser Origin. Preserve the server's existing
      // same-origin cookie mutation check rather than exempting mobile routes.
      headers.set("Origin", API_URL)
    }
    if (projectId) headers.set("x-project-id", projectId)
    const timeout = AbortSignal.timeout(20_000)
    const response = await fetch(API_URL + path, { ...options, headers, credentials: process.env.EXPO_OS === "web" ? options.credentials ?? "include" : "omit",
      signal: options.signal ? AbortSignal.any([options.signal, timeout]) : timeout })
    const payload = await response.json().catch(() => null)
    if (!response.ok) {
      // An endpoint rejection (including an old in-flight request) is not proof
      // that the current login expired. Let the session endpoint decide.
      if (response.status === 401 && options.credentials !== "omit")
        void queryClient.invalidateQueries({ queryKey: ["session"] })
      throw new ApiError(payload?.error?.message ?? `Request failed (${response.status}). Please retry.`, response.status, payload?.error?.details?.reason)
    }
    return payload as T
  } catch (error) {
    if (!options.signal?.aborted) reportError("api", error)
    throw error
  }
}
export async function api<T>(path: string, options?: RequestInit, projectId?: string) {
  return (await request<{ data: T }>(path, options, projectId)).data
}
export function build<T>(projectId: string, operation: string, input: Record<string, unknown>, options?: { signal?: AbortSignal; key?: string }) {
  return api<T>(`/api/build/${operation}`, { method: "POST", body: JSON.stringify(input),
    signal: options?.signal, headers: options?.key ? { "idempotency-key": options.key } : undefined }, projectId)
}
