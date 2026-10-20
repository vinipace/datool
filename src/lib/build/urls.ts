import { z } from "zod"

const SAFE_HTTP_PROTOCOLS = new Set(["http:", "https:"])

export const SAFE_HTTP_URL_MESSAGE =
  "Only absolute HTTP(S) URLs without embedded credentials are allowed."

/** URL values that may be placed in a browser-facing resource or link. */
export function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      SAFE_HTTP_PROTOCOLS.has(url.protocol) && !url.username && !url.password
    )
  } catch {
    return false
  }
}

export const safeHttpUrlSchema = z.string().refine(isSafeHttpUrl, {
  message: SAFE_HTTP_URL_MESSAGE,
})

export function assertSafeHttpUrl(value: string): URL {
  if (!isSafeHttpUrl(value)) throw new Error(SAFE_HTTP_URL_MESSAGE)
  return new URL(value)
}
