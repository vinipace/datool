import { createHash, randomUUID } from "node:crypto"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyReturnInputSchema,
  shopifyReturnQuoteSchema,
  type ShopifyReturnInput,
} from "@/src/lib/build/shopify-return"
import { TracerError } from "@/src/server/tracer/errors"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import { getShopifyReturnOptions } from "./shopify-return-options"

const moneyFields = `presentmentMoney { amount currencyCode }`
export const CALCULATE_RETURN = `#graphql
 query DatoolCalculateReturn($input: CalculateReturnInput!) {
   returnCalculate(input: $input) {
     returnLineItems {
       fulfillmentLineItem { id } quantity
       subtotalSet { ${moneyFields} } totalTaxSet { ${moneyFields} }
       restockingFee { amountSet { ${moneyFields} } }
     }
     exchangeLineItems {
       variant { id } quantity
       subtotalSet { ${moneyFields} } totalTaxSet { ${moneyFields} }
     }
     returnShippingFee { amountSet { ${moneyFields} } taxAmountSet { ${moneyFields} } }
   }
 }
`
export const RETURN_REPLACEMENT_VARIANTS = `#graphql
 query DatoolReturnVariants($ids: [ID!]!) {
   nodes(ids: $ids) { ... on ProductVariant {
     id title availableForSale inventoryQuantity inventoryPolicy inventoryItem { tracked }
     product { title status publishedAt requiresSellingPlan }
   } }
 }
`

export type ShopifyMoney = { amount: string; currencyCode: string }
type MoneyBag = { presentmentMoney: ShopifyMoney }
type Calculation = {
  returnLineItems: Array<{
    fulfillmentLineItem: { id: string }
    quantity: number
    subtotalSet: MoneyBag
    totalTaxSet: MoneyBag
    restockingFee: { amountSet: MoneyBag } | null
  }>
  exchangeLineItems: Array<{
    variant: { id: string } | null
    quantity: number
    subtotalSet: MoneyBag
    totalTaxSet: MoneyBag
  }>
  returnShippingFee: { amountSet: MoneyBag; taxAmountSet: MoneyBag } | null
}

function invalid(message: string): never {
  throw new TracerError("VALIDATION_ERROR", message)
}

/** Add provider decimal strings exactly; never round money through JavaScript floating point. */
export function totalShopifyMoney(
  values: Array<{ value: ShopifyMoney; subtract?: boolean }>,
  currencyCode: string
): ShopifyMoney {
  const parsed = values.map(({ value, subtract }) => {
    if (
      value.currencyCode !== currencyCode ||
      value.amount.length > 40 ||
      !/^\d+(?:\.\d{1,20})?$/.test(value.amount)
    )
      invalid(
        "Shopify returned inconsistent return amounts. Ask the store team to review the order."
      )
    const [whole, fraction = ""] = value.amount.split(".")
    return { whole, fraction, sign: subtract ? -1n : 1n }
  })
  const scale = Math.max(0, ...parsed.map((value) => value.fraction.length))
  const total = parsed.reduce(
    (sum, value) =>
      sum +
      value.sign * BigInt(value.whole + value.fraction.padEnd(scale, "0")),
    0n
  )
  const negative = total < 0n
  const digits = (negative ? -total : total).toString().padStart(scale + 1, "0")
  const decimal = scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
        .replace(/0+$/, "")
        .replace(/\.$/, "")
    : digits
  return { amount: `${negative ? "-" : ""}${decimal}`, currencyCode }
}

/** Return eligibility and amounts are refreshed on confirmation, with the original merchant settings. */
export async function prepareShopifyReturn(
  input: unknown,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operationId: string = randomUUID()
) {
  const args = shopifyReturnInputSchema.parse(input)
  if (
    new Set(args.items.map((item) => item.fulfillmentLineItemId)).size !==
    args.items.length
  )
    invalid("Combine duplicate return items before continuing.")
  if (
    new Set(args.replacements.map((item) => item.variantId)).size !==
    args.replacements.length
  )
    invalid("Combine duplicate replacement variants before continuing.")
  if (args.replacements.length && !settings.allowExchanges)
    invalid(
      "This store's action allows refunds only. Ask the store team about an exchange."
    )
  const available = await getShopifyReturnOptions(
    {
      orderId: args.orderId,
      orderNumber: args.orderNumber,
      email: args.email,
      phone: args.phone,
    },
    shopper,
    graphql
  )
  const selected = args.items.map((item) => {
    const line = available.items.find(
      (line) => line.fulfillmentLineItemId === item.fulfillmentLineItemId
    )
    if (!line || line.quantity < item.quantity)
      invalid(
        "The selected quantity is no longer available to return. Check the returnable items again."
      )
    if (settings.returnWindowDays !== null) {
      const delivery = Date.parse(line.deliveredAt ?? "")
      if (!Number.isFinite(delivery) || delivery > Date.now())
        invalid(
          "Shopify has no confirmed delivery date for this item. Ask the store team to verify return eligibility."
        )
      if (delivery + settings.returnWindowDays * 86_400_000 < Date.now())
        invalid("This item is outside the store's return window.")
    }
    return { ...line, quantity: item.quantity }
  })
  const replacements = await getShopifyReplacementItems(
    args.replacements,
    graphql
  )
  const variantIds = args.replacements.map(
    (item) => `gid://shopify/ProductVariant/${item.variantId}`
  )
  const calculationInput = {
    orderId: args.orderId,
    returnLineItems: args.items,
    exchangeLineItems: args.replacements.map((item, index) => ({
      variantId: variantIds[index],
      quantity: item.quantity,
    })),
  }
  const { returnCalculate: calculated } = await shopifyData<{
    returnCalculate: Calculation | null
  }>(graphql, CALCULATE_RETURN, { input: calculationInput })
  if (
    !calculated ||
    calculated.returnLineItems.length !== args.items.length ||
    calculated.exchangeLineItems.length !== args.replacements.length ||
    args.items.some(
      (item) =>
        !calculated.returnLineItems.some(
          (line) =>
            line.fulfillmentLineItem.id === item.fulfillmentLineItemId &&
            line.quantity === item.quantity
        )
    ) ||
    args.replacements.some(
      (item, index) =>
        !calculated.exchangeLineItems.some(
          (line) =>
            line.variant?.id === variantIds[index] &&
            line.quantity === item.quantity
        )
    )
  )
    invalid(
      "Shopify could not calculate all selected return items. Review the order before continuing."
    )
  const credit = totalShopifyMoney(
    [
      ...calculated.returnLineItems.flatMap((line) => [
        { value: line.subtotalSet.presentmentMoney },
        { value: line.totalTaxSet.presentmentMoney },
        ...(line.restockingFee
          ? [
              {
                value: line.restockingFee.amountSet.presentmentMoney,
                subtract: true,
              },
            ]
          : []),
      ]),
      ...(calculated.returnShippingFee
        ? [
            {
              value: calculated.returnShippingFee.amountSet.presentmentMoney,
              subtract: true,
            },
            {
              value: calculated.returnShippingFee.taxAmountSet.presentmentMoney,
              subtract: true,
            },
          ]
        : []),
    ],
    available.currencyCode
  )
  if (credit.amount.startsWith("-"))
    invalid(
      "The return fees exceed the item credit. Ask the store team to review this return."
    )
  const replacementTotal = totalShopifyMoney(
    calculated.exchangeLineItems.flatMap((line) => [
      { value: line.subtotalSet.presentmentMoney },
      { value: line.totalTaxSet.presentmentMoney },
    ]),
    available.currencyCode
  )
  const balance = totalShopifyMoney(
    [{ value: credit }, { value: replacementTotal, subtract: true }],
    available.currencyCode
  )
  const confirmed = {
    customerId: shopper.customerId,
    orderName: available.orderName,
    input: args,
    items: selected.map((item) => ({
      title: item.title,
      quantity: item.quantity,
    })),
    replacements,
    credit,
    replacementTotal,
    settlement: {
      direction:
        balance.amount === "0"
          ? "even"
          : balance.amount.startsWith("-")
            ? "collect"
            : "refund",
      amount: balance.amount.replace(/^-/, ""),
      currencyCode: balance.currencyCode,
    },
  }
  return shopifyReturnQuoteSchema.parse({
    operationId,
    expiresAt: Date.now() + 15 * 60_000,
    ...confirmed,
    fingerprint: createHash("sha256")
      .update(JSON.stringify({ ...confirmed, settings }))
      .digest("hex"),
  })
}

export async function getShopifyReplacementItems(
  items: ShopifyReturnInput["replacements"],
  graphql: ShopifyGraphqlClient
) {
  type Variant = {
    id: string
    title: string
    availableForSale: boolean
    inventoryQuantity: number | null
    inventoryPolicy: string
    inventoryItem: { tracked: boolean }
    product: {
      title: string
      status: string
      publishedAt: string | null
      requiresSellingPlan: boolean
    }
  }
  const variantIds = items.map(
    (item) => `gid://shopify/ProductVariant/${item.variantId}`
  )
  const variants = variantIds.length
    ? (
        await shopifyData<{ nodes: Array<Variant | null> }>(
          graphql,
          RETURN_REPLACEMENT_VARIANTS,
          { ids: variantIds }
        )
      ).nodes
    : []
  return items.map((item, index) => {
    const variant = variants.find((value) => value?.id === variantIds[index])
    if (
      !variant ||
      !variant.availableForSale ||
      variant.product.status !== "ACTIVE" ||
      !variant.product.publishedAt ||
      !(Date.parse(variant.product.publishedAt) <= Date.now()) ||
      variant.product.requiresSellingPlan ||
      (variant.inventoryItem.tracked &&
        variant.inventoryPolicy === "DENY" &&
        (variant.inventoryQuantity ?? 0) < item.quantity)
    )
      invalid(
        "A replacement is unavailable or requires the store's subscription checkout. Choose an available replacement."
      )
    return {
      title:
        variant.title && variant.title !== "Default Title"
          ? `${variant.product.title} (${variant.title})`
          : variant.product.title,
      quantity: item.quantity,
    }
  })
}
