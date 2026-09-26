import {
  accessError,
  apiError,
  hasTrustedMutationOrigin,
  readJson,
} from "@/lib/api-response"
import { requireProjectAccess } from "@/lib/project-access"
import { db } from "@/lib/db"
import { consumeAlertBudget } from "./budgets"
import { TracerError } from "../tracer/errors"
import { AlertInputError } from "./service"

export async function alertRoute(
  request: Request,
  projectId: string,
  run: () => Promise<Response>
) {
  const mutation = request.method !== "GET"
  if (mutation && !hasTrustedMutationOrigin(request))
    return apiError("FORBIDDEN", "Request origin is not trusted.", 403)
  try {
    const authorization = await requireProjectAccess(request, projectId, {
      manage: mutation,
    })
    if (authorization.kind !== "ok") return accessError(authorization.kind)
    if (mutation && !(await consumeAlertBudget(db, projectId, "mutation"))) {
      return Response.json(
        {
          error: {
            code: "RATE_LIMITED",
            message:
              "This project allows 30 alert changes per minute. Try again shortly.",
          },
        },
        {
          status: 429,
          headers: { "Retry-After": "60" },
        }
      )
    }
    return await run()
  } catch (error) {
    if (error instanceof TracerError)
      return Response.json(
        { error: { code: error.code, message: error.message } },
        {
          status: error.status,
          ...(error.status === 429 ? { headers: { "Retry-After": "1" } } : {}),
        }
      )
    if (error instanceof AlertInputError)
      return apiError(
        error.status === 413
          ? "PAYLOAD_TOO_LARGE"
          : error.status === 409
            ? "CONFLICT"
            : error.status === 404
              ? "NOT_FOUND"
              : "VALIDATION_ERROR",
        error.message,
        error.status
      )
    return apiError(
      "INTERNAL_ERROR",
      "Unable to process alerts. Try again.",
      500
    )
  }
}

export async function readAlertBody(request: Request) {
  const body = await readJson(request, 16384)
  if (body.kind === "too-large")
    throw new AlertInputError("Alert request is too large.", 413)
  if (body.kind !== "ok")
    throw new AlertInputError("Provide a valid JSON alert.")
  return body.value
}
