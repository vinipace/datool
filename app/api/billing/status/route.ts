import { billingRequest } from "@/src/server/billing/http"
export const GET = (request: Request) => billingRequest(request, "status")
