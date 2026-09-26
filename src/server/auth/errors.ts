import { APIError } from "better-auth/api"
import { ZodError } from "zod"
import { apiError } from "@/src/server/tracer/http"
export function authApiError(error: unknown) {
  if (error instanceof ZodError)
    return Response.json(
      {
        error: {
          code: "VALIDATION_ERROR",
          message: "Invalid request fields.",
          details: error.flatten(),
        },
      },
      { status: 400 }
    )
  if (
    error instanceof APIError &&
    error.statusCode >= 400 &&
    error.statusCode < 500
  ) {
    return Response.json(
      {
        error: {
          code: error.body?.code ?? "AUTHORIZATION_ERROR",
          message:
            error.body?.message ??
            error.body?.error_description ??
            "Authorization failed.",
        },
      },
      { status: error.statusCode }
    )
  }
  return apiError(error)
}
