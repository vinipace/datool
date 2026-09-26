// Run by Compose before migrations. No secrets or connection strings are logged.
const env = process.env
const errors = []
for (const key of ["BETTER_AUTH_SECRET"]) {
  if ((env[key]?.length ?? 0) < 32)
    errors.push(`${key} must contain at least 32 characters.`)
}
try {
  const url = new URL(env.BETTER_AUTH_URL)
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error()
} catch {
  errors.push(
    "BETTER_AUTH_URL must be the public HTTPS origin, without a path or credentials."
  )
}
const google = Boolean(
  env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim()
)
const email = Boolean(
  env.RESEND_API_KEY?.trim() && env.RESEND_FROM_EMAIL?.trim()
)
if (!google && !email)
  errors.push(
    "Configure Google (GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET) or magic links (RESEND_API_KEY + RESEND_FROM_EMAIL)."
  )
if (
  Boolean(env.GOOGLE_CLIENT_ID?.trim()) !==
  Boolean(env.GOOGLE_CLIENT_SECRET?.trim())
)
  errors.push(
    "Google sign-in requires both GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET."
  )
if (
  Boolean(env.RESEND_API_KEY?.trim()) !== Boolean(env.RESEND_FROM_EMAIL?.trim())
)
  errors.push("Magic links require both RESEND_API_KEY and RESEND_FROM_EMAIL.")
if (
  env.AUTH_ALLOW_PUBLIC_SIGNUP !== "true" &&
  !env.AUTH_ALLOWED_DOMAINS?.split(",").some((domain) => domain.trim())
)
  errors.push(
    "Set AUTH_ALLOWED_DOMAINS or explicitly enable AUTH_ALLOW_PUBLIC_SIGNUP."
  )
for (const key of ["DATOOL_CMS_ENABLED", "AUTH_ALLOW_PUBLIC_SIGNUP"]) {
  if (env[key] && !["true", "false"].includes(env[key]))
    errors.push(`${key} must be true or false.`)
}
if (env.DATOOL_CMS_ENABLED === "true" && (env.PAYLOAD_SECRET?.length ?? 0) < 32)
  errors.push(
    "CMS is enabled: generate a PAYLOAD_SECRET of at least 32 characters."
  )
if (errors.length) {
  console.error(
    `Self-hosting configuration is incomplete:\n${errors.map((message) => `- ${message}`).join("\n")}`
  )
  process.exit(1)
}
console.log("Self-hosting configuration accepted.")
