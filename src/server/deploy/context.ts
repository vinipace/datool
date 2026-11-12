import type { BuildContext } from "../build/context"
import {
  deploymentEnvironment,
  type DeploymentEnvironment,
} from "@/src/lib/deploy/contracts"
import { TracerError } from "../tracer/errors"

export type DeploymentContext = BuildContext & {
  environment?: DeploymentEnvironment
}
export const environmentOf = (
  context: DeploymentContext
): DeploymentEnvironment => context.environment ?? "production"
// Retain existing production locations and credential encryption bindings.
export const resourceScope = (context: DeploymentContext) =>
  environmentOf(context) === "production"
    ? context.projectId
    : `${context.projectId}:preview`
export function parseEnvironment(value: unknown): DeploymentEnvironment {
  const result = deploymentEnvironment.safeParse(value ?? "production")
  if (!result.success)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Choose preview or production as the deployment environment."
    )
  return result.data
}
