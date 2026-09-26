import type { CloudPlan } from "@/src/lib/billing"

export type ProductEvent = {
  type: "subscription.activated"
  organizationName: string
  subscriptionId: string
  plan: CloudPlan
  amountPaid: number
  currency: string
  livemode: boolean
}

/** Internal reactions to product events live here. Callers await a bounded,
 * best-effort delivery; notification failures never fail the product action. */
export async function emitProductEvent(event: ProductEvent) {
  try {
    switch (event.type) {
      case "subscription.activated": {
        const amount = new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: event.currency,
        }).format(event.amountPaid / 100) // Cloud billing uses fixed USD prices.
        const url = `https://dashboard.stripe.com/${event.livemode ? "" : "test/"}subscriptions/${encodeURIComponent(event.subscriptionId)}`
        return await notifySlack(
          process.env.SLACK_SUBSCRIPTIONS_CHANNEL,
          [
            `:tada: *New Datool paid subscription${event.livemode ? "" : " (Stripe test mode)"}*`,
            `Workspace: ${escapeSlack(event.organizationName)}`,
            `Plan: ${escapeSlack(event.plan)} · First payment: ${escapeSlack(amount)}`,
            `<${url}|View subscription>`,
          ].join("\n")
        )
      }
    }
  } catch {
    // Never log the event payload, credentials or Slack response body.
    console.error(
      JSON.stringify({ event: "product_notification_failed", type: event.type })
    )
    return "failed" as const
  }
}

async function notifySlack(channel: string | undefined, text: string) {
  // A shared bot can serve several event destinations. Each channel opts in
  // independently; configuring deployments need not enable subscription alerts.
  if (!channel) return "disabled" as const
  const token = process.env.SLACK_BOT_TOKEN
  if (!token || !/^[CG][A-Z0-9]+$/.test(channel))
    throw new Error("Incomplete operator Slack configuration")
  const response = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      channel,
      text,
      unfurl_links: false,
      unfurl_media: false,
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!response.ok) throw new Error("Slack request failed")
  const result = (await response.json()) as {
    ok?: boolean
    ts?: string
    channel?: string
  }
  if (!result.ok || !result.ts || result.channel !== channel)
    throw new Error("Slack delivery failed")
  return "sent" as const
}

function escapeSlack(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}
