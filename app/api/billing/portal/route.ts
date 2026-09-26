import { billingRequest } from "@/src/server/billing/http"
export const POST = (request: Request) => billingRequest(request, "portal")
