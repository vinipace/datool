/** Apply the install's billing mode to every write connection, including workers.
 * Preserve URL search_path options used by isolated test databases. */
export function billingDatabaseUrl(value: string, connectionOptions = "") {
  const url = new URL(value)
  const options = url.searchParams.get("options") ?? ""
  url.searchParams.set(
    "options",
    `${options} ${connectionOptions} -c datool.billing_enabled=${process.env.DATOOL_BILLING_ENABLED === "true" ? "true" : "false"}`.trim()
  )
  return url.toString()
}
