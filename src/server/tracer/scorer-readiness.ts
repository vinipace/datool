import { assertManagedProject } from "@/src/server/execution-credits/config"
import type { EvaluatorVersion, JsonObject } from "@/src/lib/tracer/contracts"
import { resolveJudgeOptions } from "../model-providers/judge"
import { getSandboxExecutionProviders } from "../sandbox/providers-store"
import { assertJudgeConfigured } from "./llm-scorer"
import type { TracerDatabase } from "./db"
import { libraryEvaluator } from "@/src/lib/tracer/scorer-libraries"
import { scorerInputSchema } from "@/src/lib/tracer/scorers"

/** Configuration only: never contacts a model service or launches a sandbox. */
export async function scorerReadiness(
  version: EvaluatorVersion,
  projectId: string,
  database: TracerDatabase
): Promise<JsonObject> {
  const config = version.config
  const runtime =
    config?.type === "llm"
      ? {
          type: "llm",
          provider: config.provider ?? "openai",
          model: config.model,
          modelType: config.modelType,
        }
      : {
          type: config?.type ?? version.language,
          ...(config?.library
            ? {
                library: config.library,
                provider: config.provider,
                model: config.model,
              }
            : {}),
        }
  try {
    let providers: string[] = []
    if (config?.type === "library") {
      scorerInputSchema.parse(config)
      if (libraryEvaluator(config.library!.evaluator).modelRequired)
        assertJudgeConfigured(
          await resolveJudgeOptions(config, projectId, database)
        )
    } else if (config?.type === "llm")
      assertJudgeConfigured(
        await resolveJudgeOptions(config, projectId, database)
      )
    else {
      const configured = await getSandboxExecutionProviders(projectId, database)
      if (!configured.length)
        throw new Error("Configure a sandbox provider in project settings.")
      providers = configured.map((provider) => provider.id)
      for (const provider of configured) {
        if (provider.id === "datool")
          await assertManagedProject(projectId, "sandbox")
        provider.credentials()
      }
    }
    return {
      scorerId: version.evaluatorId,
      versionId: version.id,
      runtime: JSON.parse(JSON.stringify(runtime)),
      providers,
      configuration: "present",
      authentication: "not_checked",
      connectivity: "not_checked",
      execution: "not_checked",
    }
  } catch (error) {
    return {
      scorerId: version.evaluatorId,
      versionId: version.id,
      runtime: JSON.parse(JSON.stringify(runtime)),
      configuration: "missing_or_invalid",
      authentication: "not_checked",
      connectivity: "not_checked",
      execution: "not_checked",
      message:
        error instanceof Error && error.message.startsWith("Configure ")
          ? error.message
          : "Provider configuration could not be loaded. Replace the selected provider credentials in project settings.",
    }
  }
}
