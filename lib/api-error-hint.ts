/** Additive guidance keeps existing error codes, messages, and details stable. */
export function apiErrorHint(status: number) {
  switch (status) {
    case 400:
      return "Check the request fields against /openapi.json. Project APIs require x-project-id (or projectId)."
    case 401:
      return "Send Authorization: Bearer <token> and x-project-id. Use an organization API key or OAuth from /.well-known/oauth-authorization-server."
    case 402:
      return "Open /billing to activate or update the organization's Cloud subscription."
    case 403:
      return "Check the token's project, granted scopes, organization role, and request origin."
    case 404:
      return "Check the resource identifier and project. Discover available API operations at /openapi.json and /docs."
    case 409:
      return "Read the current resource revision and reconcile your changes before retrying."
    case 413:
      return "Reduce the request or result size, use a smaller page, or narrow the query."
    case 422:
      return "Inspect the operation inputs and recorded failure details before retrying."
    case 429:
      return "Honor Retry-After when present. For a record limit, update the plan in /billing or wait for the next billing period."
    case 504:
      return "Narrow the time range, filters, or page size before retrying the read."
    default:
      return "Try again later. Check the operation state before retrying a mutation to avoid duplicate work."
  }
}
