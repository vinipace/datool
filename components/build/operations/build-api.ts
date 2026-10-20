"use client"

import { buildApi as sharedBuildApi, BuildApiError } from "@/src/lib/build/client"

/**
 * Build pages deliberately use the same operation endpoint as MCP. This keeps
 * the browser and the agent interface on one authorization and validation
 * contract; pages never write directly to a Build table or local storage.
 */
export type BuildOperation = string
export type BuildCallOptions = { signal?: AbortSignal; idempotencyKey?: string; requestKey?: string }

export const buildApi = {
  call<T>(operation: BuildOperation, input: unknown = {}, signalOrOptions?: AbortSignal | BuildCallOptions) {
    const options = signalOrOptions instanceof AbortSignal ? { signal: signalOrOptions } : signalOrOptions ?? {}
    return sharedBuildApi.call<T>(operation, (input ?? {}) as Record<string, unknown>, {
      ...options,
      idempotencyKey: options.idempotencyKey ?? crypto.randomUUID(),
    })
  },
}

export { BuildApiError }

export function asList<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    for (const key of ["items", "rows", "data", "results"]) {
      if (Array.isArray(record[key])) return record[key] as T[]
    }
  }
  return []
}

export function asRecord<T extends Record<string, unknown> = Record<string, unknown>>(
  value: unknown,
): T {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as T)
    : ({} as T)
}
