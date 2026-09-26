import { ReadBudgetError, READ_MAX_BYTES } from "../semantic/read-budget"

/** Keep complete values and cursor semantics; reduce the batch, never truncate evidence. */
export async function fitEvalPage<T>(
  limit: number,
  read: (limit: number) => Promise<T>
): Promise<T> {
  let size = Math.max(1, Math.min(limit, 200))
  for (;;) {
    try {
      const page = await read(size)
      if (Buffer.byteLength(JSON.stringify(page)) > READ_MAX_BYTES)
        throw new ReadBudgetError(
          "READ_RESULT_TOO_LARGE",
          "This eval case exceeds 8 MiB."
        )
      return page
    } catch (error) {
      if (
        !(error instanceof ReadBudgetError) ||
        error.code !== "READ_RESULT_TOO_LARGE" ||
        size === 1
      )
        throw error
      size = Math.max(1, Math.floor(size / 2))
    }
  }
}
