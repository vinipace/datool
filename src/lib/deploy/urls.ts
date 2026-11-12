import type { DeploymentEnvironment } from "./contracts"

export function deploymentMcpPath(deploymentId: string) {
  return `/api/project-mcp/${deploymentId.replaceAll("-", "")}`
}

export function projectMcpPath(
  projectId: string,
  deploymentId: string,
  environment: DeploymentEnvironment
) {
  return environment === "production"
    ? `/api/project-mcp/${encodeURIComponent(projectId)}`
    : deploymentMcpPath(deploymentId)
}
