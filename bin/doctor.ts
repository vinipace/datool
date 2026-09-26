import { cliProtocolVersion } from "../src/lib/auth/cli-contract"
import { configuredOrigin, type Configuration } from "./config"
import { appRequest, DatoolRequestError } from "./request"
import { readProfile } from "./credentials"

type Check = {
  name: string
  ok: boolean
  message: string
  status?: number
  missingScopes?: string[]
}

export async function doctor(configuration: Configuration) {
  const origin = configuredOrigin()
  const version = process.env.DATOOL_CLI_VERSION ?? "development"
  const hasLogin = !process.env.DATOOL_API_KEY?.trim() && !!(await readProfile())
  const checks: Check[] = []
  const option = (name: string) => {
    const index = configuration.args.indexOf(name)
    return index < 0 ? undefined : configuration.args[index + 1]
  }
  const scorerIds = option("--scorer-ids")?.split(",").filter(Boolean)
  const probe = configuration.args.includes("--probe")
  let scorerRuntime: unknown
  try {
    const response = await fetch(`${origin}/api/cli/info`, {
      signal: AbortSignal.timeout(10_000),
      redirect: "error",
    })
    const info = response.ok ? (await response.json()).data : null
    const minimum =
      typeof info?.minimumCliVersion === "string" &&
      /^\d+\.\d+\.\d+$/.test(info.minimumCliVersion)
        ? info.minimumCliVersion
        : null
    const atLeast = (left: string, right: string) => {
      const a = left.split(".").map(Number),
        b = right.split(".").map(Number)
      for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] > b[i]
      }
      return true
    }
    const ok =
      !!minimum &&
      info.protocolVersion === cliProtocolVersion &&
      (version === "development" || atLeast(version, minimum))
    checks.push({
      name: "compatibility",
      ok,
      status: response.status,
      message: ok
        ? `CLI ${version}; server protocol ${cliProtocolVersion}; minimum CLI ${minimum}.`
        : "Server is older or incompatible with this CLI. Update the CLI/server together; expected CLI protocol 1.",
    })
  } catch {
    checks.push({
      name: "compatibility",
      ok: false,
      message:
        "Could not read server compatibility. Check the host and network.",
    })
  }
  for (const [name, path, body] of [
    ["authentication", "/api/cli/session", undefined],
    ["trace-read", "/api/agent/list_traces", { limit: 1 }],
  ] as const) {
    try {
      await appRequest(origin, path, body)
      checks.push({
        name,
        ok: true,
        message:
          name === "trace-read"
            ? "Minimal trace read succeeded (limit 1)."
            : "Credential accepted for the selected project.",
      })
    } catch (error) {
      checks.push({
        name,
        ok: false,
        message:
          error instanceof DatoolRequestError
            ? error.message
            : "Request could not complete. Check host, project, API key or saved OAuth login and credential-store access.",
        ...(error instanceof DatoolRequestError
          ? { status: error.status, missingScopes: error.missingScopes }
          : {}),
      })
    }
  }
  if (scorerIds?.length || probe) {
    try {
      if (!scorerIds?.length || (probe && !option("--trace-id")))
        throw new Error("Use --scorer-ids id,id; --probe additionally requires --trace-id and may incur provider usage.")
      const result = await appRequest<{ checks: { configuration: string; execution: string }[] }>(origin,
        `/api/agent/${probe ? "probe_scorer_runtime" : "check_scorer_runtime"}`,
        { scorerIds, ...(probe ? { traceId: option("--trace-id"), ...(option("--span-id") ? { spanId: option("--span-id") } : {}) } : {}) },
        { timeoutMs: 120_000 })
      scorerRuntime = result
      checks.push({ name: "scorer-runtime", ok: result.checks.every(check => check.configuration === "present" && (!probe || check.execution === "succeeded")), message: probe ? "Representative runtime probe completed; inspect scorerRuntime for execution and connectivity." : "Configuration inspected only; connectivity and execution were not checked. Use --probe explicitly for a potentially billable execution." })
    } catch (error) {
      checks.push({ name: "scorer-runtime", ok: false, message: error instanceof Error ? error.message : "Runtime diagnostics failed." })
    }
  }
  const report = {
    ok: checks.every((check) => check.ok),
    cliVersion: version,
    host: origin,
    project: process.env.DATOOL_PROJECT_ID ?? null,
    authentication: process.env.DATOOL_API_KEY?.trim()
      ? "api-key"
      : hasLogin
        ? "saved-oauth"
        : "none",
    configuration: {
      root: configuration.root,
      files: configuration.files,
      sources: {
        host:
          configuration.sources.DATOOL_BASE_URL ??
          configuration.sources.DATOOL_URL ??
          "default",
        project: configuration.sources.DATOOL_PROJECT_ID ?? "unset",
        authentication: process.env.DATOOL_API_KEY?.trim()
          ? (configuration.sources.DATOOL_API_KEY ?? "environment")
          : hasLogin
            ? "OS credential store"
            : "unset",
      },
    },
    checks,
    ...(scorerRuntime ? { scorerRuntime } : {}),
  }
  if (configuration.args.includes("--json"))
    console.info(JSON.stringify(report, null, 2))
  else {
    console.info(
      `Datool CLI ${version}\nHost: ${origin}\nProject: ${report.project ?? "unset"}\nAuthentication: ${report.authentication}`
    )
    console.info(`Configuration: ${JSON.stringify(report.configuration)}`)
    for (const check of checks)
      console.info(
        `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.message}`
      )
    if (scorerRuntime) console.info(JSON.stringify(scorerRuntime, null, 2))
  }
  return report.ok ? 0 : 1
}
