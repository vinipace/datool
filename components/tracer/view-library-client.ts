"use client"
import { projectFetch } from "@/lib/workspace-routing"
export async function callViewOperation<T>(projectId: string, operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
  const response = await projectFetch("/api/agent/" + encodeURIComponent(operation), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input), signal,
  }, projectId)
  const body = await response.json()
  if (!response.ok) throw new Error(body.error?.message ?? "The view operation failed.")
  return body.data as T
}
