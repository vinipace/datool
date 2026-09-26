/** Public signup is explicit opt-in; verified Google email is always required. */
export function isAllowedGoogleUser(
  user: { email?: string | null; emailVerified?: boolean },
  domains = process.env.AUTH_ALLOWED_DOMAINS ?? "",
  allowPublicSignup = process.env.AUTH_ALLOW_PUBLIC_SIGNUP === "true"
) {
  if (user.emailVerified !== true || !user.email) return false
  return isAllowedEmail(user.email, domains, allowPublicSignup)
}

export function isAllowedEmail(
  email: string,
  domains = process.env.AUTH_ALLOWED_DOMAINS ?? "",
  allowPublicSignup = process.env.AUTH_ALLOW_PUBLIC_SIGNUP === "true"
) {
  const parts = email.toLowerCase().split("@")
  if (parts.length !== 2 || !parts[0] || !parts[1]) return false
  if (allowPublicSignup) return true
  return domains.split(",").some((domain) => {
    const normalized = domain.trim().toLowerCase()
    return normalized !== "" && normalized === parts[1]
  })
}
