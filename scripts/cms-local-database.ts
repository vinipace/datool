export function assertLocalCMSDatabase(value: string | undefined) {
  if (!value)
    throw new Error(
      "Set PAYLOAD_DATABASE_URL to a disposable local CMS database."
    )
  const url = new URL(value)
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
    !/^\/datool_cms(?:_[a-z0-9_]+)?$/.test(url.pathname)
  ) {
    throw new Error(
      "CMS seed/tests require a loopback Postgres database named datool_cms or datool_cms_*. Remote databases are refused."
    )
  }
}
