import { lookup } from "node:dns/promises"
import { BlockList, isIP } from "node:net"
import { request as httpRequest } from "node:http"
import { request as httpsRequest } from "node:https"

const blocked = new BlockList()
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4")
const globalV6 = new BlockList()
globalV6.addSubnet("2000::", 3, "ipv6")
blocked.addSubnet("2001::", 23, "ipv6")
blocked.addSubnet("2001:db8::", 32, "ipv6")
blocked.addSubnet("2002::", 16, "ipv6")

export function isPublicAlertAddress(address: string) {
  const family = isIP(address)
  if (family === 4) return !blocked.check(address, "ipv4")
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !blocked.check(address, "ipv6")
  )
}

export function validateWebhookUrl(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Enter a valid HTTPS webhook URL.")
  }
  const local =
    process.env.NODE_ENV !== "production" &&
    process.env.DATOOL_ALERT_LOCAL_WEBHOOKS === "1" &&
    url.hostname === "127.0.0.1"
  if (
    (!local && url.protocol !== "https:") ||
    (local && !["http:", "https:"].includes(url.protocol)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error(
      "Use an HTTPS webhook URL without credentials or a fragment."
    )
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  if (
    !local &&
    (hostname === "localhost" ||
      (isIP(hostname) && !isPublicAlertAddress(hostname)))
  )
    throw new Error("Webhook destinations must use public Internet addresses.")
  return { url, local, hostname }
}

export async function deliverWebhook(
  value: string,
  deliveryId: string,
  payload: unknown
): Promise<void> {
  const { url, local, hostname } = validateWebhookUrl(value)
  // Resolve once, validate all answers and pin the connection to an approved IP.
  // No redirect following, credential forwarding, or second DNS lookup.
  let dnsTimer: ReturnType<typeof setTimeout> | undefined
  const answers = await Promise.race([
    lookup(hostname, { all: true }).catch(() => {
      throw new Error("Webhook DNS lookup failed.")
    }),
    new Promise<never>((_resolve, reject) => {
      dnsTimer = setTimeout(
        () => reject(new Error("Webhook DNS lookup timed out.")),
        3000
      )
    }),
  ]).finally(() => clearTimeout(dnsTimer))
  if (
    !answers.length ||
    (!local && answers.some((answer) => !isPublicAlertAddress(answer.address)))
  )
    throw new Error("Webhook destination resolved to a restricted address.")
  const selected = answers[0]
  const body = JSON.stringify(payload)
  await new Promise<void>((resolve, reject) => {
    const request = (url.protocol === "http:" ? httpRequest : httpsRequest)(
      url,
      {
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "idempotency-key": deliveryId,
          "user-agent": "Datool-Alerts/1.0",
        },
        lookup: (_host, options, callback) => {
          if (options.all) callback(null, [selected])
          else callback(null, selected.address, selected.family)
        },
      },
      (response) => {
        const status = response.statusCode ?? 0
        response.destroy()
        if (status >= 200 && status < 300) resolve()
        else reject(new Error(`Webhook returned HTTP ${status}.`))
      }
    )
    const timer = setTimeout(
      () => request.destroy(new Error("Webhook timed out after 8 seconds.")),
      8000
    )
    request.once("close", () => clearTimeout(timer))
    request.once("error", (error) =>
      reject(
        error.message.startsWith("Webhook ")
          ? error
          : new Error("Webhook connection failed.")
      )
    )
    request.end(body)
  })
}
