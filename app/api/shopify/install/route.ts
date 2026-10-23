import { db } from "@/lib/db"
import { beginShopifyInstall } from "@/src/server/build/integrations/shopify-install"
export const runtime = "nodejs"
export async function GET(request: Request) {
  try {
    return await beginShopifyInstall(db, request)
  } catch {
    return new Response("Open Datool from Shopify to start a new connection.", {
      status: 400,
      headers: {
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      },
    })
  }
}
