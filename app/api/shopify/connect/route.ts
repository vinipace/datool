import { db } from "@/lib/db"
import { beginShopifyAuthorization } from "@/src/server/build/integrations/shopify"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    return await beginShopifyAuthorization(db, request)
  } catch {
    return new Response(
      "This Shopify connection link is invalid or expired. Start again from Datool Integrations.",
      {
        status: 400,
        headers: {
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        },
      }
    )
  }
}
