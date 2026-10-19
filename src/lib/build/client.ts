import { projectFetch } from "@/lib/workspace-routing"
import type { ApiEnvelope, ApiError } from "@/src/lib/tracer/contracts"

export class BuildApiError extends Error {
  readonly code?: string
  readonly details?: unknown
  readonly status: number

  constructor(
    message: string,
    status: number,
    options?: { code?: string; details?: unknown }
  ) {
    super(message)
    this.name = "BuildApiError"
    this.status = status
    this.code = options?.code
    this.details = options?.details
  }
}

export type BuildCallOptions = Omit<RequestInit, "body" | "method"> & {
  projectId?: string
  idempotencyKey?: string
  requestKey?: string
}

async function responsePayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return response.text()
  return response.json()
}

/** Shared browser transport for every Build page and operation. */
export async function callBuild<T = unknown>(
  operation: string,
  input: Record<string, unknown> = {},
  options: BuildCallOptions = {}
): Promise<T> {
  if (!/^build_[a-z][a-z0-9_]{1,119}$/.test(operation))
    throw new BuildApiError("Invalid Build operation name.", 400, {
      code: "VALIDATION_ERROR",
    })

  const { projectId, idempotencyKey, requestKey, ...requestOptions } = options
  const headers = new Headers(requestOptions.headers)
  headers.set("content-type", "application/json")
  if (idempotencyKey) headers.set("idempotency-key", idempotencyKey)
  if (requestKey) headers.set("x-request-key", requestKey)
  const response = await projectFetch(
    `/api/build/${encodeURIComponent(operation)}`,
    {
      ...requestOptions,
      method: "POST",
      body: JSON.stringify(input),
      cache: "no-store",
      credentials: "include",
      headers,
    },
    projectId
  )
  const payload = await responsePayload(response)
  if (
    !response.ok ||
    (typeof payload === "object" && payload !== null && "error" in payload)
  ) {
    const error = payload as ApiError
    throw new BuildApiError(
      error.error?.message ?? `Build request failed (${response.status})`,
      response.status,
      { code: error.error?.code, details: error.error?.details }
    )
  }
  return (payload as ApiEnvelope<T>).data
}

export type BuildOperationDescription = {
  name: string
  description: string
  scopes: readonly string[]
  destructive: boolean
  idempotent: boolean
  idempotency: "none" | "optional" | "required"
  expectedRevision: "none" | "optional" | "required"
  maxInputBytes: number
  inputSchema: Record<string, unknown>
}

export const buildApi = {
  call: callBuild,
  describe: (options?: Pick<BuildCallOptions, "signal" | "projectId">) =>
    callBuild<BuildOperationDescription[]>("build_describe_operations", {}, options),
}
