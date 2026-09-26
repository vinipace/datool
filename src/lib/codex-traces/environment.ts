/** Datool credentials are for the connector, never tools in the observed Codex run. */
export function codexEnvironment(
  source: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([key]) =>
        !key.startsWith("DATOOL_") &&
        ![
          "DATABASE_URL",
          "REDIS_URL",
          "BETTER_AUTH_SECRET",
          "GOOGLE_CLIENT_SECRET",
        ].includes(key)
    )
  ) as NodeJS.ProcessEnv
}
