import { apiError } from "@/lib/api-response"

/** Specific API handlers always take precedence over this missing-route fallback. */
function missingApi() {
  return apiError("NOT_FOUND", "This API endpoint does not exist.", 404)
}

export const GET = missingApi
export const POST = missingApi
export const PUT = missingApi
export const PATCH = missingApi
export const DELETE = missingApi
export const OPTIONS = missingApi
