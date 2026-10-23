import { TracerError } from "@/src/server/tracer/errors"
import type { ShopifyGraphqlClient } from "./shopify-catalog"

export class ShopifyWriteUncertainError extends Error {
  readonly uncertain = true
  constructor() {
    super(
      "Shopify did not confirm the action's outcome. Check the store before retrying; it may already have completed."
    )
  }
}

/** A timeout after dispatch is not proof that a commerce write failed. */
export async function shopifyMutation<
  T extends {
    userErrors: Array<{ field?: string[] | null; message?: string }>
  },
>(
  graphql: ShopifyGraphqlClient,
  query: string,
  variables: Record<string, unknown>,
  field: string,
  beforeWrite: () => Promise<void>
): Promise<T> {
  await beforeWrite()
  let response: Response
  let result: { data?: Record<string, T>; errors?: unknown[] }
  try {
    response = await graphql(query, { variables })
    result = await response.json()
  } catch {
    throw new ShopifyWriteUncertainError()
  }
  const payload = result.data?.[field]
  if (!response.ok || !payload) throw new ShopifyWriteUncertainError()
  if (payload.userErrors?.length)
    throw new TracerError(
      "VALIDATION_ERROR",
      "Shopify rejected this change. Check the supplied details and store permissions before trying again."
    )
  if (result.errors?.length || !Array.isArray(payload.userErrors))
    throw new ShopifyWriteUncertainError()
  return payload
}
