import { createTracerDatabase } from "@/src/server/tracer/db"
import { handleShopifyCommerceWebhook } from "@/src/server/build/integrations/shopify-webhook"

export const runtime = "nodejs"

export async function POST(request: Request) {
  return handleShopifyCommerceWebhook(
    request,
    createTracerDatabase(undefined, { projectId: "shopify-webhook" })
  )
}
