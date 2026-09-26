// Loaded only by the disposable test's NODE_OPTIONS, never by the application.
import { writeFileSync } from "node:fs"
const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url
  if (url !== "https://api.resend.com/emails") return realFetch(input, init)
  writeFileSync("/test-mail/latest.json", String(init.body), { mode: 0o600 })
  return Response.json({ id: "self-hosting-local-mail-fixture" })
}
