/** Web origins owned by this installation. Native schemes are handled by auth. */
export function trustedAuthWebOrigins(baseURL: string): string[] {
  const origin = new URL(baseURL).origin
  // The first TestFlight release uses the Cloud apex host. Keep its native
  // requests compatible with Cloud's canonical www auth host; self-hosted
  // installations do not inherit this exception or wildcard subdomains.
  return origin === "https://www.trydatool.com"
    ? [origin, "https://trydatool.com"]
    : [origin]
}
