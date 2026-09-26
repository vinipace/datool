import { projectFetch } from "@/lib/workspace-routing"

export async function promptRequest<T>(
  path = "",
  method = "GET",
  body?: unknown,
  signal?: AbortSignal
): Promise<T> {
  const response = await projectFetch(`/api/prompts${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  })
  const result = await response.json()
  if (!response.ok)
    throw new Error(result.error?.message ?? "Unable to load or save prompt.")
  return result.data
}
