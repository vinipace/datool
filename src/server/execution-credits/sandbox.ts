import type { SandboxJob } from "@/src/server/sandbox/provider-runtime"
import type { EvaluatorRunResult } from "@/src/lib/tracer/contracts"
import {
  executeSandboxProvider,
  sandboxFailure,
} from "@/src/server/sandbox/provider-runtime"
import { assertManagedProject } from "./config"
import { executionCredits, ExecutionCreditError } from "./ledger"

// 1 physical CPU + 0.25 GiB. Credits use observed allocated wall time;
// provider invoice cost is separate and is never invented from scorer metadata.
export const SANDBOX_NANO_USD_PER_SECOND = 39_420 + 6_670 / 4
export const SANDBOX_RATE_VERSION = "datool-modal-1cpu-256mib-2026-09-22"
export const SANDBOX_RESERVATION = Math.ceil(120 * SANDBOX_NANO_USD_PER_SECOND)
export async function runManagedSandbox(
  projectId: string,
  job: SandboxJob,
  options: {
    credits?: typeof executionCredits
    assertProject?: typeof assertManagedProject
    execute?: typeof executeSandboxProvider
  } = {}
): Promise<EvaluatorRunResult> {
  const credits = options.credits ?? executionCredits
  let operation: string | undefined
  try {
    await (options.assertProject ?? assertManagedProject)(projectId, "sandbox")
    operation = await credits.reserve(
      projectId,
      "sandbox",
      SANDBOX_RESERVATION,
      SANDBOX_RATE_VERSION
    )
    const operationId = operation
    const result = await (options.execute ?? executeSandboxProvider)(
      {
        provider: "modal",
        tokenId: process.env.DATOOL_MODAL_TOKEN_ID!,
        tokenSecret: process.env.DATOOL_MODAL_TOKEN_SECRET!,
      },
      {
        ...job,
        onModalCreated: (sandboxId) =>
          credits.recordEvidence(operationId, sandboxId, {
            allocationStartedAt: new Date().toISOString(),
          }),
        onModalUsage: async ({ sandboxId, allocatedMs }) => {
          await credits.settle(
            operationId,
            Math.ceil((allocatedMs / 1000) * SANDBOX_NANO_USD_PER_SECOND),
            sandboxId,
            {
              allocatedMs,
              cpu: 1,
              memoryMiB: 256,
              measurement: "server-observed-allocation",
              providerInvoiceCost: null,
            }
          )
        },
      }
    )
    return {
      ...result,
      metadata: {
        ...result.metadata,
        fundingSource: "datool",
        creditOperations: [operation],
      },
    }
  } catch (error) {
    return {
      ...sandboxFailure(
        "sandbox",
        error instanceof ExecutionCreditError
          ? error.message
          : "Datool Sandbox is unavailable. Any uncertain usage stays reserved in Usage."
      ),
      metadata: {
        fundingSource: "datool",
        ...(operation ? { creditOperations: [operation] } : {}),
        runtimeDiagnostic: {
          category:
            error instanceof ExecutionCreditError ? "quota" : "unavailable",
        },
      },
    }
  }
}
