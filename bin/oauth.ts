import { createServer } from "node:http"
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { z } from "zod"
import { workspaceScopes } from "../src/lib/auth/permissions"
import { cliProtocolVersion } from "../src/lib/auth/cli-contract"
import { configuredOrigin } from "./config"
import {
  clearLogin,
  readCredential,
  readProfile,
  saveLogin,
  systemCredentialStore,
  withCredentialLock,
  type Credential,
  type CredentialStore,
  type Profile,
} from "./credentials"

const tokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1),
  token_type: z.string().refine((value) => value.toLowerCase() === "bearer"),
  expires_in: z.number().positive().max(86400),
})
async function jsonRequest(url: string, init: RequestInit = {}) {
  let response: Response
  try {
    response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    })
  } catch {
    throw new Error("Could not reach the Datool authentication server.")
  }
  if (!response.ok)
    throw new Error(
      `Datool authentication failed (HTTP ${response.status}). Run datool auth login to reconnect if the saved session was revoked.`
    )
  try {
    return await response.json()
  } catch {
    throw new Error("Datool returned an invalid authentication response.")
  }
}
function endpoint(value: unknown, origin: string) {
  if (typeof value !== "string")
    throw new Error("Server does not advertise the required OAuth endpoint.")
  const url = new URL(value)
  if (
    url.origin !== origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  )
    throw new Error(
      "OAuth endpoint does not belong to the selected Datool host."
    )
  return url.href
}
async function exchange(url: string, body: Record<string, string>) {
  const parsed = tokenSchema.safeParse(
    await jsonRequest(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body),
    })
  )
  if (!parsed.success)
    throw new Error("Datool returned an invalid OAuth token response.")
  return parsed.data
}

export async function accessCredential(
  profile: Profile,
  store = systemCredentialStore,
  directory?: string
): Promise<Credential> {
  const credential = await readCredential(profile, store)
  if (credential.expiresAt > Date.now() + 30_000) return credential
  return withCredentialLock(
    profile.id,
    async () => {
      const current = await readCredential(profile, store)
      if (current.expiresAt > Date.now() + 30_000) return current
      const token = await exchange(current.tokenEndpoint, {
        grant_type: "refresh_token",
        client_id: current.clientId,
        refresh_token: current.refreshToken,
        resource: `${profile.origin}/api/cli`,
      })
      const refreshed = {
        ...current,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
      }
      await store.write(profile.id, JSON.stringify(refreshed))
      return refreshed
    },
    directory
  )
}

export async function openBrowser(url: string) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "rundll32.exe"
        : "xdg-open"
  await promisify(execFile)(
    command,
    process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url]
  )
}

/** Loopback callback, S256 PKCE and random state; no codes or tokens are logged. */
export async function login(options: {
  origin: string
  open?: (url: string) => Promise<void>
  store?: CredentialStore
  directory?: string
  timeoutMs?: number
}): Promise<Profile> {
  const { origin, store = systemCredentialStore } = options
  const info = (await jsonRequest(`${origin}/api/cli/info`)).data
  if (
    info?.protocolVersion !== cliProtocolVersion ||
    info.oauthResource !== `${origin}/api/cli` ||
    info.issuer !== `${origin}/api/auth`
  )
    throw new Error(
      "Server does not support this CLI OAuth protocol. Update the Datool server."
    )
  const metadata = await jsonRequest(
    `${origin}/.well-known/oauth-authorization-server/api/auth`
  )
  if (
    metadata.issuer !== info.issuer ||
    !metadata.code_challenge_methods_supported?.includes("S256")
  )
    throw new Error(
      "Server does not advertise the required OAuth issuer and S256 PKCE."
    )
  const authorizationEndpoint = endpoint(
    metadata.authorization_endpoint,
    origin
  )
  const tokenEndpoint = endpoint(metadata.token_endpoint, origin)
  const registrationEndpoint = endpoint(metadata.registration_endpoint, origin)
  const revocationEndpoint = metadata.revocation_endpoint
    ? endpoint(metadata.revocation_endpoint, origin)
    : undefined
  const state = randomBytes(32).toString("base64url")
  const verifier = randomBytes(48).toString("base64url")
  let resolveCode!: (code: string) => void
  let rejectCode!: (error: Error) => void
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve
    rejectCode = reject
  })
  // Attach immediately: a denied callback can arrive while the browser is opening.
  void code.catch(() => {})
  const callback = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1")
    response.setHeader("Cache-Control", "no-store")
    response.setHeader("Content-Type", "text/plain; charset=utf-8")
    if (request.method !== "GET" || url.pathname !== "/callback") {
      response.writeHead(404).end("Not found")
      return
    }
    const incoming = Buffer.from(url.searchParams.get("state") ?? "")
    const expected = Buffer.from(state)
    if (
      incoming.length !== expected.length ||
      !timingSafeEqual(incoming, expected)
    ) {
      response.writeHead(400).end("Invalid login state.")
      return
    }
    if (url.searchParams.has("error") || !url.searchParams.get("code")) {
      response
        .writeHead(400)
        .end("Login was not approved. Return to your terminal.")
      rejectCode(new Error("Browser login was not approved."))
      return
    }
    response.end(
      "Authorization received. Return to your terminal to finish login."
    )
    resolveCode(url.searchParams.get("code")!)
  })
  const timeout = setTimeout(
    () =>
      rejectCode(
        new Error("Browser login timed out. Run datool auth login to retry.")
      ),
    options.timeoutMs ?? 180_000
  )
  try {
    await new Promise<void>((resolve, reject) => {
      callback.once("error", reject)
      callback.listen(0, "127.0.0.1", resolve)
    })
    const address = callback.address()
    if (!address || typeof address === "string")
      throw new Error("Cannot start the login callback.")
    const redirectUri = `http://127.0.0.1:${address.port}/callback`
    const scope = [...workspaceScopes, "offline_access"].join(" ")
    const registration = await jsonRequest(registrationEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        application_type: "native",
        client_name: "Datool CLI",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        scope,
        resources: [`${origin}/api/cli`],
      }),
    })
    if (typeof registration.client_id !== "string")
      throw new Error("Server returned an invalid OAuth client registration.")
    const url = new URL(authorizationEndpoint)
    url.search = new URLSearchParams({
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope,
      resource: `${origin}/api/cli`,
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
      prompt: "consent",
    }).toString()
    await (options.open ?? openBrowser)(url.href)
    const token = await exchange(tokenEndpoint, {
      grant_type: "authorization_code",
      client_id: registration.client_id,
      redirect_uri: redirectUri,
      code: await code,
      code_verifier: verifier,
      resource: `${origin}/api/cli`,
    })
    // The signed token supplies the selected project; the server validates it before persistence.
    let projectId: string
    try {
      projectId = z
        .string()
        .min(1)
        .max(200)
        .parse(
          JSON.parse(
            Buffer.from(
              token.access_token.split(".")[1],
              "base64url"
            ).toString()
          ).projectId
        )
    } catch {
      throw new Error("Server returned a token without a project binding.")
    }
    const session = (
      await jsonRequest(`${origin}/api/cli/session`, {
        headers: {
          authorization: `Bearer ${token.access_token}`,
          "x-project-id": projectId,
        },
      })
    ).data
    if (
      session?.projectId !== projectId ||
      typeof session.organizationId !== "string" ||
      session.kind !== "oauth"
    )
      throw new Error("Server did not confirm the OAuth project binding.")
    const profile: Profile = {
      id: randomUUID(),
      origin,
      projectId,
      organizationId: session.organizationId,
    }
    await saveLogin(
      profile,
      {
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + token.expires_in * 1000,
        clientId: registration.client_id,
        tokenEndpoint,
        revocationEndpoint,
      },
      store,
      options.directory
    )
    return profile
  } finally {
    clearTimeout(timeout)
    callback.closeAllConnections()
    await new Promise<void>((resolve) => callback.close(() => resolve()))
  }
}

export async function authCommand(args: string[]) {
  if (args[0] !== "auth") return null
  if (
    args[1] === "login" &&
    (args.length === 2 || (args.length === 3 && args[2] === "--no-browser"))
  ) {
    console.error(
      "Opening Datool. Select your organization and project, then approve access."
    )
    const profile = await login({
      origin: configuredOrigin(),
      ...(args.includes("--no-browser")
        ? {
            open: async (url: string) => {
              console.error(`Open this URL on this computer: ${url}`)
            },
          }
        : {}),
    })
    console.info(
      `Logged in to ${profile.origin}, project ${profile.projectId}. Credentials saved in the OS credential store.`
    )
    if (process.env.DATOOL_API_KEY)
      console.error(
        "DATOOL_API_KEY is set and takes precedence over this saved login."
      )
    return 0
  }
  if (args[1] === "logout" && args.length === 2) {
    const profile = await readProfile()
    if (profile) {
      const credential = await readCredential(profile)
      if (credential.revocationEndpoint) {
        try {
          const response = await fetch(credential.revocationEndpoint, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              token: credential.refreshToken,
              token_type_hint: "refresh_token",
              client_id: credential.clientId,
            }),
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          })
          if (!response.ok) throw new Error("Revocation failed")
        } catch {
          console.error(
            "Server revocation could not be confirmed. Revoke this connection in Datool to invalidate outstanding tokens."
          )
        }
      }
      await clearLogin(profile)
    }
    console.info(
      "Saved Datool login removed. Environment API keys are managed by your shell or project configuration."
    )
    return 0
  }
  throw new Error(
    "Usage: datool auth login|logout. Use datool doctor to check authentication."
  )
}
