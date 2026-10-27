/** Public URLs must stay consistent even when documentation is built offline. */
export function publicOrigin() {
  return new URL(process.env.BETTER_AUTH_URL || "https://www.trydatool.com")
    .origin
}
