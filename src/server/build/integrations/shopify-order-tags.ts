import { z } from "zod"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { requireShopifyCustomer, type ShopifyShopper } from "./shopify-identity"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"

const tagSchema = z
  .object({
    orderId: z.string().regex(/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/),
    tags: z.array(z.string().min(1).max(100)).min(1).max(30),
  })
  .strict()

export const ORDER_OWNER = `#graphql
  query DatoolOrderOwner($id: ID!) { order(id: $id) { id customer { id } } }
`
export const ORDER_TAGS_ADD = `#graphql
  mutation DatoolOrderTags($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } }
  }
`

export async function tagShopifyOrder(
  input: Record<string, unknown>,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  beforeWrite: () => Promise<void>
) {
  const args = tagSchema.parse(input)
  const customerId = requireShopifyCustomer(shopper)
  if (!args.tags.every((tag) => settings.allowedOrderTags.includes(tag)))
    throw new Error(
      "This action can only apply the order tags allowed by the store."
    )
  const result = await shopifyData<{
    order: { id: string; customer: { id: string } | null } | null
  }>(graphql, ORDER_OWNER, { id: args.orderId })
  if (
    result.order?.id !== args.orderId ||
    result.order.customer?.id !== customerId
  )
    throw new Error("No matching accessible order was found.")
  const tagged = await shopifyMutation<{
    node: { id: string } | null
  }>(
    graphql,
    ORDER_TAGS_ADD,
    { id: result.order.id, tags: args.tags },
    "tagsAdd",
    beforeWrite
  )
  if (tagged.node?.id !== result.order.id)
    throw new ShopifyWriteUncertainError()
  return {
    status: "updated",
    message: "The requested order tags have been added.",
  }
}

export const shopifyTagTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_TAG_ORDER",
    name: "Tag an order",
    description:
      "Apply merchant-approved tags to the signed-in customer's own order. Only tags configured by the merchant are allowed; a tag cannot authorize refunds or override store policies.",
    inputSchema: z.toJSONSchema(tagSchema, { target: "draft-7" }),
  },
]
