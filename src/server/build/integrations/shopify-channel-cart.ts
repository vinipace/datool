import { sql } from "drizzle-orm"
import { z } from "zod"
import {
  shopifyCartSchema,
  type ShopifyCartCommand,
} from "@/src/lib/build/shopify-cart"
import { TracerError } from "@/src/server/tracer/errors"
import type { BuildContext } from "../context"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"

const itemsSchema = z
  .array(
    z.object({
      variantId: z.string().regex(/^[1-9][0-9]{0,15}$/),
      quantity: z.number().int().min(1).max(99),
    })
  )
  .max(100)

const CART_VARIANTS = `#graphql
  query DatoolChannelCart($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant {
      id title price availableForSale
      product { title status publishedAt requiresSellingPlan handle }
    } }
    shop { currencyCode }
  }
`

/** A conversation cart is a selection for Shopify checkout, separate from a browser's cart.
 * The action usage ledger rejects retries before entry; the row lock serializes selections.
 */
export async function shopifyChannelCart(
  context: BuildContext,
  connectionId: string,
  execution: { conversationId: string; turnId: string },
  shop: string,
  command: Exclude<ShopifyCartCommand, { operation: "complete_order" }>,
  graphql: ShopifyGraphqlClient
) {
  return context.database.transaction(async (tx) => {
    const rows = await tx.execute<{ items: unknown }>(sql`
      SELECT c.metadata_json->'shopifyCarts'->${connectionId} AS items
      FROM build_conversations c
      JOIN build_conversation_turns t ON t.project_id=c.project_id AND t.conversation_id=c.id
        AND t.owner_fence=c.owner_fence
      WHERE c.project_id=${context.projectId} AND c.id=${execution.conversationId}
        AND t.id=${execution.turnId} AND c.owner_type='ai'
      FOR UPDATE OF c
    `)
    const row = rows.rows[0]
    if (!row) throw new Error("Cart conversation is no longer available.")
    const items = new Map(
      itemsSchema
        .parse(row.items ?? [])
        .map((item) => [item.variantId, item.quantity])
    )
    if (command.operation === "add")
      for (const item of command.items)
        items.set(
          item.variantId,
          (items.get(item.variantId) ?? 0) + item.quantity
        )
    if (command.operation === "set") {
      if (!items.has(command.lineKey))
        throw new TracerError(
          "VALIDATION_ERROR",
          "Read the cart again before changing this line."
        )
      if (command.quantity) items.set(command.lineKey, command.quantity)
      else items.delete(command.lineKey)
    }
    const selection = itemsSchema.parse(
      [...items].map(([variantId, quantity]) => ({ variantId, quantity }))
    )
    const data = await shopifyData<{
      shop: { currencyCode: string }
      nodes: Array<null | {
        id: string
        title: string
        price: string
        availableForSale: boolean
        product: {
          title: string
          status: string
          publishedAt: string | null
          requiresSellingPlan: boolean
          handle: string
        }
      }>
    }>(graphql, CART_VARIANTS, {
      ids: selection.map(
        (item) => `gid://shopify/ProductVariant/${item.variantId}`
      ),
    })
    const lines = selection.flatMap((item) => {
      const variant = data.nodes.find(
        (node) => node?.id === `gid://shopify/ProductVariant/${item.variantId}`
      )
      if (
        !variant ||
        variant.product.status !== "ACTIVE" ||
        !variant.product.publishedAt ||
        Date.parse(variant.product.publishedAt) > Date.now() ||
        !variant.availableForSale ||
        variant.product.requiresSellingPlan
      ) {
        const requested =
          command.operation === "add"
            ? command.items.some((added) => added.variantId === item.variantId)
            : command.operation === "set" && command.lineKey === item.variantId
        if (requested)
          throw new TracerError(
            "VALIDATION_ERROR",
            "An item is unavailable or requires a subscription. Choose an available product on the store."
          )
        // Refresh stale selections without preventing reads or removals.
        return []
      }
      return [
        {
          lineKey: item.variantId,
          ...item,
          title: `${variant.product.title} — ${variant.title}`.slice(0, 300),
          // Shopify cart amounts use hundredths even for JPY and KRW.
          finalLinePrice:
            Math.round(Number(variant.price) * 100) * item.quantity,
          url: `https://${shop}/products/${encodeURIComponent(variant.product.handle)}?variant=${item.variantId}`,
        },
      ]
    })
    const currentSelection = lines.map(({ variantId, quantity }) => ({
      variantId,
      quantity,
    }))
    const removedUnavailable = currentSelection.length !== selection.length
    const checkoutUrl = currentSelection.length
      ? `https://${shop}/cart/${currentSelection.map((item) => `${item.variantId}:${item.quantity}`).join(",")}`
      : `https://${shop}/cart`
    const result = {
      message:
        (removedUnavailable
          ? "Unavailable or subscription items were removed from your chat cart. "
          : "Your chat cart. ") +
        "Shopify confirms availability, discounts, shipping and the final total at checkout.",
      source: "conversation_cart",
      shopifyCart: shopifyCartSchema.parse({
        currency: data.shop.currencyCode,
        totalPrice: lines.reduce((sum, line) => sum + line.finalLinePrice, 0),
        itemCount: lines.reduce((sum, line) => sum + line.quantity, 0),
        items: lines,
        truncated: false,
        requiresStoreCheckout: false,
        cartUrl: checkoutUrl,
        checkoutUrl,
      }),
    }
    if (command.operation !== "read" || removedUnavailable) {
      await tx.execute(
        sql`UPDATE build_conversations SET metadata_json=jsonb_set(metadata_json,'{shopifyCarts}',COALESCE(metadata_json->'shopifyCarts','{}'::jsonb) || jsonb_build_object(${connectionId}::text,${JSON.stringify(currentSelection)}::jsonb)) WHERE project_id=${context.projectId} AND id=${execution.conversationId}`
      )
    }
    return result
  })
}
