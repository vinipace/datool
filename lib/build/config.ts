/** Runtime opt-in shared by the web process and Build worker. */
export function buildOrganizationIds(): string[] {
  return [
    ...new Set(
      (process.env.DATOOL_BUILD_ORGANIZATION_IDS ?? "")
        .split(",")
        .map((id) => id.trim())
        .filter(Boolean)
    ),
  ]
}

/** Only a server-verified organization ID may select an allowlist entry. */
export function buildEnabled(organizationId?: string | null) {
  return (
    process.env.DATOOL_BUILD_ENABLED === "true" ||
    Boolean(organizationId && buildOrganizationIds().includes(organizationId))
  )
}

/** Early process/route gate; tenant admission still requires buildEnabled(id). */
export function buildAvailable() {
  return buildEnabled() || buildOrganizationIds().length > 0
}
