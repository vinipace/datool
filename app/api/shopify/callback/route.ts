import { completeShopifyInstall } from "@/src/server/build/integrations/shopify-install"
import { db } from "@/lib/db"
import { completeShopifyAuthorization } from "@/src/server/build/integrations/shopify"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    return (
      (await completeShopifyInstall(db, request)) ??
      (await completeShopifyAuthorization(db, request))
    )
  } catch {
    return new Response(
      "Shopify authorization could not be completed. Return to Datool Integrations and reconnect the store.",
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
