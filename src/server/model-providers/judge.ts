import {
  DATOOL_PROVIDER,
  DATOOL_SCORER_MODEL,
} from "@/src/lib/execution-credits"
import {
  assertManagedProject,
  managedExecutionEnabled,
} from "@/src/server/execution-credits/config"
import { managedModelFetch } from "@/src/server/execution-credits/model"
import type { TracerDatabase } from "@/src/server/tracer/db"
import type { ScorerInput } from "@/src/lib/tracer/scorers"
import { modelProviders } from "@/src/lib/model-providers"
import { getProjectProviderKey } from "./store"
import type { JudgeOptions } from "@/src/server/tracer/llm-scorer"

export async function resolveJudgeOptions(
  config: ScorerInput,
  projectId?: string,
  database?: TracerDatabase
): Promise<JudgeOptions> {
  // Self-hosted legacy scorers retain their server OpenAI route. Cloud managed
  // execution requires explicit funding so legacy versions cannot bypass credits.
  if (!config.provider) {
    if (managedExecutionEnabled())
      throw new Error(
        "Select Datool Scorer Model or a configured project provider to run this scorer."
      )
    return {}
  }
  if (!projectId)
    throw new Error(
      `Project context is required to use ${modelProviders[config.provider].name}.`
    )
  if (config.provider === DATOOL_PROVIDER) {
    if (config.model !== DATOOL_SCORER_MODEL || config.imagePaths?.length)
      throw new Error("Configure Datool Scorer Model with text evidence only.")
    await assertManagedProject(projectId, "model")
    const creditOperations: string[] = []
    return {
      provider: DATOOL_PROVIDER,
      apiKey: "managed-by-datool",
      baseUrl: "https://api.openai.com/v1",
      fetch: managedModelFetch(projectId, creditOperations),
      creditOperations,
    }
  }
  return {
    apiKey: await getProjectProviderKey(projectId, config.provider, database),
    baseUrl: modelProviders[config.provider].baseUrl,
    provider: config.provider,
  }
}
