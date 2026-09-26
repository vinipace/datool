export function localEndpoint(value: string, protocols: readonly string[]) {
  const url = new URL(value)
  if (
    !protocols.includes(url.protocol) ||
    !["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Read load tests require explicit loopback endpoints.")
  return url
}
export function boundedInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number
) {
  const parsed = value === undefined ? fallback : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max)
    throw new Error(
      `Load setting must be an integer between ${min} and ${max}.`
    )
  return parsed
}
