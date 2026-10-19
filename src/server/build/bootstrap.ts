// Importing this module loads every domain operation into the shared registry.
// Keep this as the only side-effectful Build import used by transports.
import "./operations"

export {
  buildOperations,
  buildOperationCatalog,
  buildOperationInputSchema,
  executeBuildOperation,
  findBuildOperation,
  registerBuildOperation,
  registerBuildOperations,
} from "./api"
export { getBuildContext } from "./context"
export type {
  BuildContext,
  BuildExecutionOptions,
  BuildIdempotency,
  BuildOperation,
  BuildRevisionPolicy,
} from "./api"
