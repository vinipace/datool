import { existsSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { parseEnv } from "node:util"

export type Configuration = {
  root: string
  files: string[]
  sources: Record<string, string>
  args: string[]
}

/** The nearest package or Git root is the project, including from subdirectories. */
export function projectRoot(cwd: string) {
  let directory = resolve(cwd)
  while (true) {
    if (
      existsSync(resolve(directory, "package.json")) ||
      existsSync(resolve(directory, ".git"))
    )
      return directory
    const parent = dirname(directory)
    if (parent === directory) return resolve(cwd)
    directory = parent
  }
}

export function loadConfiguration(
  argv: string[],
  env: NodeJS.Dict<string> = process.env,
  cwd = process.cwd()
): Configuration {
  const args: string[] = []
  const explicit: string[] = []
  const overrides: Record<string, string> = {}
  let disabled = env.DATOOL_NO_ENV === "1"
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--no-env") {
      disabled = true
      continue
    }
    if (["--env-file", "--datool", "--project"].includes(arg)) {
      const value = argv[++index]
      if (!value || value.startsWith("--"))
        throw new Error(`${arg} requires a value.`)
      if (arg === "--env-file") explicit.push(resolve(cwd, value))
      else
        overrides[
          arg === "--datool" ? "DATOOL_BASE_URL" : "DATOOL_PROJECT_ID"
        ] = value
    } else args.push(arg)
  }
  if (disabled && explicit.length)
    throw new Error(
      "--env-file cannot be combined with --no-env or DATOOL_NO_ENV=1."
    )
  const root = projectRoot(cwd)
  const inherited = new Set(Object.keys(env))
  const sources: Record<string, string> = Object.fromEntries(
    [...inherited]
      .filter((key) => key.startsWith("DATOOL_"))
      .map((key) => [key, "environment"])
  )
  const files: string[] = []
  for (const file of disabled
    ? []
    : explicit.length
      ? explicit
      : [resolve(root, ".env"), resolve(root, ".env.local")]) {
    if (!explicit.length && !existsSync(file)) continue
    let values: NodeJS.Dict<string>
    try {
      values = parseEnv(readFileSync(file, "utf8"))
    } catch {
      throw new Error(`Cannot load environment file: ${file}`)
    }
    files.push(file)
    for (const [key, value] of Object.entries(values)) {
      if (inherited.has(key)) continue
      env[key] = value
      if (key.startsWith("DATOOL_")) sources[key] = file
    }
    if (
      !inherited.has("DATOOL_BASE_URL") &&
      !inherited.has("DATOOL_URL") &&
      (values.DATOOL_BASE_URL !== undefined || values.DATOOL_URL !== undefined)
    ) {
      env.DATOOL_BASE_URL = values.DATOOL_BASE_URL ?? values.DATOOL_URL
      sources.DATOOL_BASE_URL = file
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    env[key] = value
    sources[key] = "flag"
  }
  // Treat the two host names as aliases when comparing configuration priority.
  if (
    !overrides.DATOOL_BASE_URL &&
    inherited.has("DATOOL_URL") &&
    !inherited.has("DATOOL_BASE_URL")
  ) {
    env.DATOOL_BASE_URL = env.DATOOL_URL
    sources.DATOOL_BASE_URL = "environment (DATOOL_URL)"
  }
  return { root, files, sources, args }
}

export function serverOrigin(value: string) {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Datool host must be an absolute HTTPS origin.")
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "Datool host must be an HTTPS origin; HTTP is allowed on loopback only."
    )
  }
  return url.origin
}

export const configuredOrigin = () =>
  serverOrigin(
    process.env.DATOOL_BASE_URL ??
      process.env.DATOOL_URL ??
      "http://127.0.0.1:3000"
  )
