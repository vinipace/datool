import { createDatoolClient } from "@datool/sdk/agents"

export const options = {
  baseUrl: process.env.DATOOL_BASE_URL ?? "http://localhost:3000",
  apiKey: process.env.DATOOL_API_KEY!,
  projectId: process.env.DATOOL_PROJECT_ID!,
  connectionId: process.env.DATOOL_CONNECTION_ID!,
}
export const workspaces = { acme: "Acme Studio", orbit: "Orbit Labs" } as const
export type Workspace = keyof typeof workspaces

// Deliberately simulated sign-in for this loopback-only sample.
// Replace this with your session/auth provider in a deployed application.
export function demoAuth(req: Request) {
  if (process.env.DATOOL_DEMO_ENABLED !== "true")
    throw new Error(
      "The local demo is disabled. Configure your authentication."
    )
  const selected = req.headers
    .get("cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith("datool_demo_workspace="))
    ?.split("=")[1]
  const orgId: Workspace = selected === "orbit" ? "orbit" : "acme"
  return {
    orgId,
    userId: `demo_owner_${orgId}`,
    drive: `${process.env.DATOOL_DEMO_DRIVE_PREFIX ?? "react_sdk_demo"}_${orgId}`,
    workspaceName: workspaces[orgId],
  }
}
export function agentFor(req: Request) {
  const { userId, drive, workspaceName } = demoAuth(req)
  return createDatoolClient(options).agent({
    connectionId: options.connectionId,
    userId,
    drive,
    workspaceName,
  })
}
