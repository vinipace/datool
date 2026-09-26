import {
  billingConfig,
  billingEnabled,
  getStripe,
} from "@/src/server/billing/config"
import { processBillingEvent } from "@/src/server/billing/store"

export const runtime = "nodejs"
export async function POST(request: Request) {
  if (!billingEnabled()) return new Response(null, { status: 404 })
  const signature = request.headers.get("stripe-signature")
  if (!signature) return new Response("Missing signature", { status: 400 })
  // Verify the exact raw bytes; never acknowledge work scheduled after a response.
  const reader = request.body?.getReader()
  if (!reader) return new Response("Missing body", { status: 400 })
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > 1024 * 1024) {
      await reader.cancel()
      return new Response("Payload too large", { status: 413 })
    }
    chunks.push(value)
  }
  let event
  try {
    event = await getStripe().webhooks.constructEventAsync(
      Buffer.concat(chunks),
      signature,
      billingConfig().webhookSecret
    )
  } catch {
    return new Response("Invalid signature", { status: 400 })
  }
  try {
    await processBillingEvent(event)
    return Response.json({ received: true })
  } catch {
    // A non-2xx response lets Stripe retry; don't log billing payloads or secrets.
    console.error(
      "Stripe subscription synchronization failed; event will be retried."
    )
    return new Response("Please retry", { status: 500 })
  }
}
