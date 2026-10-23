import { createHmac, timingSafeEqual } from "node:crypto"

import {
  timingSafeStringEquals,
  type VisitorContext,
} from "@/src/lib/build/channels"

export function channelSigningSecret() {
  const secret =
    process.env.DATOOL_CHANNEL_SIGNING_SECRET ?? process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32)
    throw new Error(
      "DATOOL_CHANNEL_SIGNING_SECRET or BETTER_AUTH_SECRET is required."
    )
  return secret
}

export function signVisitorContext(
  context: Omit<VisitorContext, "issuedAt" | "expiresAt"> & {
    issuedAt?: number
    expiresAt?: number
  },
  now = Math.floor(Date.now() / 1000)
) {
  const payload: VisitorContext = {
    ...context,
    issuedAt: context.issuedAt ?? now,
    expiresAt: context.expiresAt ?? now + 60 * 60 * 24 * 30,
  }
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url")
  const signature = createHmac("sha256", channelSigningSecret())
    .update(encoded)
    .digest("base64url")
  return `${encoded}.${signature}`
}

export function verifyVisitorContext(
  token: string,
  options: { origin?: string; connectionId?: string; now?: number } = {}
): VisitorContext {
  const [encoded, signature, extra] = token.split(".")
  if (!encoded || !signature || extra)
    throw new Error("Invalid visitor context.")
  const expected = createHmac("sha256", channelSigningSecret())
    .update(encoded)
    .digest("base64url")
  const left = Buffer.from(signature)
  const right = Buffer.from(expected)
  if (
    left.length !== right.length ||
    !timingSafeEqual(left, right) ||
    !timingSafeStringEquals(signature, expected)
  )
    throw new Error("Invalid visitor context.")
  let parsed: VisitorContext
  try {
    parsed = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as VisitorContext
  } catch {
    throw new Error("Invalid visitor context.")
  }
  const now = options.now ?? Math.floor(Date.now() / 1000)
  if (
    !parsed.visitorId ||
    !Number.isFinite(parsed.issuedAt) ||
    !Number.isFinite(parsed.expiresAt)
  )
    throw new Error("Invalid visitor context.")
  if (parsed.expiresAt <= now || parsed.issuedAt > now + 60)
    throw new Error("Visitor context expired.")
  if (options.connectionId && parsed.connectionId !== options.connectionId)
    throw new Error("Visitor context connection does not match.")
  if (options.origin && parsed.origin !== options.origin)
    throw new Error("Visitor context origin does not match.")
  return parsed
}
