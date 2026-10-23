import { createHash, randomUUID } from "node:crypto"
import { z } from "zod"
import { TracerError } from "@/src/server/tracer/errors"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import type { ShopifyActionSettings } from "@/src/lib/build/shopify"
import {
  shopifyOrderInputSchema,
  shopifyOrderQuoteSchema,
  type ShopifyOrderQuote,
} from "@/src/lib/build/shopify-order"
import type { IntegrationTool } from "@/src/lib/build/integrations"
import { shopifyData, type ShopifyGraphqlClient } from "./shopify-catalog"
import type { ShopifyShopper } from "./shopify-identity"
import { shopifyMutation, ShopifyWriteUncertainError } from "./shopify-mutation"

export const ORDER_VARIANTS = `#graphql
  query DatoolOrderVariants($ids: [ID!]!) {
    nodes(ids: $ids) { ... on ProductVariant {
      id title availableForSale inventoryQuantity inventoryPolicy
      inventoryItem { tracked requiresShipping }
      product { title status publishedAt requiresSellingPlan }
    } }
    shop { currencyCode }
    paymentTermsTemplates(paymentTermsType: RECEIPT) { id paymentTermsType }
  }
`
const totals = `subtotalPriceSet { presentmentMoney { amount currencyCode } }
 totalShippingPriceSet { presentmentMoney { amount currencyCode } }
 totalTaxSet { presentmentMoney { amount currencyCode } }
 totalPriceSet { presentmentMoney { amount currencyCode } }`
export const ORDER_CALCULATE = `#graphql
 mutation DatoolCalculateOrder($input: DraftOrderInput!) {
   draftOrderCalculate(input: $input) {
     calculatedDraftOrder {
       ${totals}
       availableShippingRates { handle title price { amount currencyCode } }
       lineItems { title variantTitle quantity }
       transformerFingerprint
     }
     userErrors { field message }
   }
 }
`
export const ORDER_CREATE = `#graphql
 mutation DatoolCreateOrder($input: DraftOrderInput!) {
   draftOrderCreate(input: $input) {
     draftOrder { id invoiceUrl ${totals} paymentTerms { paymentTermsType } }
     userErrors { field message }
   }
 }
`
export const ORDER_COMPLETE = `#graphql
 mutation DatoolCompleteOrder($id: ID!) {
   draftOrderComplete(id: $id) {
     draftOrder { id order { id name displayFinancialStatus fullyPaid } }
     userErrors { field message }
   }
 }
`

type Money = ShopifyOrderQuote["total"]
type Totals = {
  subtotalPriceSet: { presentmentMoney: Money }
  totalShippingPriceSet: { presentmentMoney: Money }
  totalTaxSet: { presentmentMoney: Money }
  totalPriceSet: { presentmentMoney: Money }
}
type Calculation = Totals & {
  availableShippingRates: Array<{ handle: string; title: string; price: Money }>
  lineItems: Array<{
    title: string
    variantTitle: string | null
    quantity: number
  }>
  transformerFingerprint: string | null
}
function invalid(message: string): never {
  throw new TracerError("VALIDATION_ERROR", message)
}
function amount(value: string) {
  if (!/^\d+(?:\.\d+)?$/.test(value))
    invalid("Shopify returned an invalid amount.")
  return value.includes(".")
    ? value.replace(/0+$/, "").replace(/\.$/, "")
    : value
}
function money(value: Money): Money {
  return { ...value, amount: amount(value.amount) }
}
function summary(value: Totals) {
  return {
    subtotal: money(value.subtotalPriceSet.presentmentMoney),
    shipping: money(value.totalShippingPriceSet.presentmentMoney),
    tax: money(value.totalTaxSet.presentmentMoney),
    total: money(value.totalPriceSet.presentmentMoney),
  }
}
async function calculate(
  graphql: ShopifyGraphqlClient,
  input: Record<string, unknown>
) {
  // Calculation has no persisted order or payment side effect.
  const data = await shopifyData<{
    draftOrderCalculate: {
      calculatedDraftOrder: Calculation | null
      userErrors: unknown[]
    }
  }>(graphql, ORDER_CALCULATE, { input })
  if (
    data.draftOrderCalculate.userErrors.length ||
    !data.draftOrderCalculate.calculatedDraftOrder
  )
    invalid(
      "Shopify could not calculate this order. Check the items, address and shipping option."
    )
  return data.draftOrderCalculate.calculatedDraftOrder
}

/** Build only variant-backed lines; all money, discounts and payment behavior come from Shopify and merchant settings. */
export async function prepareShopifyOrder(
  input: unknown,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  operationId: string = randomUUID()
) {
  const args = shopifyOrderInputSchema.parse(input)
  if (!args.items?.length)
    invalid("Choose items or read the current cart before creating an order.")
  if (
    new Set(args.items.map((item) => item.variantId)).size !== args.items.length
  )
    invalid("Combine duplicate variants before creating an order.")
  const ids = args.items.map(
    (item) => `gid://shopify/ProductVariant/${item.variantId}`
  )
  type Variant = {
    id: string
    title: string
    availableForSale: boolean
    inventoryQuantity: number | null
    inventoryPolicy: string
    inventoryItem: { tracked: boolean; requiresShipping: boolean }
    product: {
      title: string
      status: string
      publishedAt: string | null
      requiresSellingPlan: boolean
    }
  }
  const data = await shopifyData<{
    nodes: Array<Variant | null>
    shop: { currencyCode: string }
    paymentTermsTemplates: Array<{ id: string; paymentTermsType: string }>
  }>(graphql, ORDER_VARIANTS, { ids })
  const variants = ids.map((id, index) => {
    const variant = data.nodes.find((item) => item?.id === id)
    if (
      !variant ||
      variant.product.status !== "ACTIVE" ||
      !variant.product.publishedAt ||
      !(Date.parse(variant.product.publishedAt) <= Date.now()) ||
      !variant.availableForSale
    )
      invalid(
        "One of these products is no longer available. Choose an available product and review the order again."
      )
    if (variant.product.requiresSellingPlan)
      invalid(
        "This subscription product must be purchased through the store checkout."
      )
    if (
      variant.inventoryItem.tracked &&
      variant.inventoryPolicy === "DENY" &&
      (variant.inventoryQuantity ?? 0) < args.items![index].quantity
    )
      invalid(
        "There is not enough stock for the requested quantity. Reduce it and review the order again."
      )
    return variant
  })
  const needsShipping = variants.some(
    (variant) => variant.inventoryItem.requiresShipping
  )
  if (needsShipping && !args.shippingAddress)
    invalid("Collect the delivery address before creating this order.")
  if (
    needsShipping &&
    settings.shippingPhone === "required" &&
    !args.shippingAddress?.phone
  )
    invalid("This store requires a phone number for delivery.")
  if (settings.shippingPhone === "omit" && args.shippingAddress)
    delete args.shippingAddress.phone
  const draftInput: Record<string, unknown> = {
    email: args.email,
    lineItems: args.items.map((item) => ({
      variantId: `gid://shopify/ProductVariant/${item.variantId}`,
      quantity: item.quantity,
    })),
    ...(shopper.customerId
      ? {
          purchasingEntity: {
            customerId: `gid://shopify/Customer/${shopper.customerId}`,
          },
        }
      : {}),
    ...(args.shippingAddress ? { shippingAddress: args.shippingAddress } : {}),
    ...(args.billingAddress ? { billingAddress: args.billingAddress } : {}),
    useCustomerDefaultAddress: false,
    presentmentCurrencyCode: data.shop.currencyCode,
    acceptAutomaticDiscounts: settings.paymentMethod !== "free",
    allowDiscountCodesInCheckout: settings.paymentMethod === "online",
    ...(settings.paymentMethod !== "free" && args.discountCodes
      ? { discountCodes: args.discountCodes }
      : {}),
    tags: [
      ...new Set([
        ...settings.orderTags,
        "datool",
        `datool-operation-${operationId}`,
      ]),
    ],
    note: settings.orderNote.replaceAll(
      "{{paymentModeLabel}}",
      settings.paymentMethod === "online"
        ? "Online payment"
        : settings.paymentMethod === "free"
          ? "Free order"
          : "Cash on delivery"
    ),
  }
  if (settings.paymentMethod === "cash_on_delivery") {
    const terms = data.paymentTermsTemplates.find(
      (item) => item.paymentTermsType === "RECEIPT"
    )
    if (!terms)
      invalid(
        "Shopify payment terms are unavailable. Ask the store to review its cash-on-delivery configuration."
      )
    draftInput.paymentTerms = { paymentTermsTemplateId: terms.id }
  }
  if (settings.paymentMethod === "free") {
    draftInput.appliedDiscount = {
      value: 100,
      valueType: "PERCENTAGE",
      title: "Merchant-authorized free order",
    }
    if (needsShipping)
      draftInput.shippingLine = {
        title: "Free delivery",
        priceWithCurrency: {
          amount: "0",
          currencyCode: data.shop.currencyCode,
        },
      }
  }
  let calculated = await calculate(graphql, draftInput)
  let shippingTitle: string | null =
    needsShipping && settings.paymentMethod === "free" ? "Free delivery" : null
  if (needsShipping && settings.paymentMethod !== "free") {
    const rates = calculated.availableShippingRates.filter(
      (rate) => rate.price.currencyCode === data.shop.currencyCode
    )
    const rate = args.shippingRateHandle
      ? rates.find((rate) => rate.handle === args.shippingRateHandle)
      : rates.toSorted(
          (a, b) => Number(a.price.amount) - Number(b.price.amount)
        )[0]
    if (!rate)
      invalid(
        "Shopify has no matching delivery option for this address. Check the address or choose another shipping option."
      )
    draftInput.shippingLine = { shippingRateHandle: rate.handle }
    args.shippingRateHandle = rate.handle
    shippingTitle = rate.title
    calculated = await calculate(graphql, draftInput)
  }
  if (calculated.transformerFingerprint)
    draftInput.transformerFingerprint = calculated.transformerFingerprint
  const financials = summary(calculated)
  if (
    Object.values(financials).some(
      (value) => value.currencyCode !== data.shop.currencyCode
    )
  )
    invalid("Shopify returned inconsistent order currencies.")
  if (settings.paymentMethod === "free" && financials.total.amount !== "0")
    invalid(
      "Shopify did not calculate a zero-cost order. Ask the store to review the free-order configuration."
    )
  const normalizedInput = { ...args, items: args.items }
  const confirmed = {
    customerId: shopper.customerId,
    input: normalizedInput,
    paymentMethod: settings.paymentMethod,
    items: calculated.lineItems.map((item) => ({
      title:
        item.variantTitle && item.variantTitle !== "Default Title"
          ? `${item.title} (${item.variantTitle})`
          : item.title,
      quantity: item.quantity,
    })),
    shippingTitle,
    ...financials,
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ ...confirmed, settings }))
    .digest("hex")
  const quote = shopifyOrderQuoteSchema.parse({
    operationId,
    expiresAt: Date.now() + 15 * 60_000,
    ...confirmed,
    fingerprint,
  })
  return { quote, draftInput }
}

/** The quote is loaded from the server-owned continuation, never from model/public input. */
export async function createShopifyOrder(
  quote: ShopifyOrderQuote,
  shopper: ShopifyShopper,
  settings: ShopifyActionSettings,
  graphql: ShopifyGraphqlClient,
  beforeWrite: () => Promise<void>,
  recordDraft: (id: string) => Promise<void>
) {
  if (quote.customerId !== shopper.customerId)
    invalid("Your customer account changed. Review the order again.")
  const prepared = await prepareShopifyOrder(
    quote.input,
    shopper,
    settings,
    graphql,
    quote.operationId
  )
  if (
    quote.expiresAt <= Date.now() ||
    quote.fingerprint !== prepared.quote.fingerprint
  )
    return { status: "quote_changed" as const, quote: prepared.quote }
  const result = await shopifyMutation<{
    draftOrder:
      | (Totals & {
          id: string
          invoiceUrl: string | null
          paymentTerms: { paymentTermsType: string } | null
        })
      | null
  }>(
    graphql,
    ORDER_CREATE,
    {
      input: {
        ...prepared.draftInput,
        // An unpaid checkout link must not let repeated chat requests hold stock.
        // Reserve only when this action is immediately completing an order.
        ...(settings.paymentMethod !== "online"
          ? {
              reserveInventoryUntil: new Date(
                Date.now() + 15 * 60_000
              ).toISOString(),
            }
          : {}),
      },
    },
    "draftOrderCreate",
    beforeWrite
  )
  const draft = result.draftOrder
  if (!draft?.id) throw new ShopifyWriteUncertainError()
  // Retain the external ID before a possible second write or lost process.
  try {
    await recordDraft(draft.id)
  } catch {
    throw new ShopifyWriteUncertainError()
  }
  let actual: ReturnType<typeof summary>
  try {
    actual = summary(draft)
  } catch {
    // A malformed response does not undo a draft that Shopify already created.
    throw new ShopifyWriteUncertainError()
  }
  if (JSON.stringify(actual) !== JSON.stringify(summaryFromQuote(quote)))
    return {
      status: "needs_review" as const,
      draftOrderId: draft.id,
      message:
        "Shopify's total changed while creating the draft. The order was not finalized. A teammate must review this draft before continuing.",
    }
  if (settings.paymentMethod === "online") {
    if (
      !draft.invoiceUrl ||
      !isSafeHttpUrl(draft.invoiceUrl) ||
      !draft.invoiceUrl.startsWith("https://")
    )
      throw new ShopifyWriteUncertainError()
    return {
      status: "checkout_ready" as const,
      draftOrderId: draft.id,
      checkoutUrl: draft.invoiceUrl,
      total: actual.total,
      message: `Your Shopify checkout is ready. The order will be finalized after payment.\n\n[Continue to Shopify checkout](<${draft.invoiceUrl}>)`,
    }
  }
  if (
    settings.paymentMethod === "cash_on_delivery" &&
    draft.paymentTerms?.paymentTermsType !== "RECEIPT"
  )
    return {
      status: "needs_review" as const,
      draftOrderId: draft.id,
      message:
        "The draft is awaiting review because Shopify did not retain the cash-on-delivery payment terms. No order was finalized.",
    }
  // If completion cannot be confirmed, do not create another draft or replay the write.
  let completed: {
    draftOrder: {
      id: string
      order: {
        id: string
        name: string
        displayFinancialStatus: string
        fullyPaid: boolean
      } | null
    } | null
  }
  try {
    completed = await shopifyMutation(
      graphql,
      ORDER_COMPLETE,
      { id: draft.id },
      "draftOrderComplete",
      beforeWrite
    )
  } catch {
    throw new ShopifyWriteUncertainError()
  }
  const order = completed.draftOrder?.order
  if (
    !order ||
    completed.draftOrder?.id !== draft.id ||
    (settings.paymentMethod === "cash_on_delivery" && order.fullyPaid)
  )
    throw new ShopifyWriteUncertainError()
  return {
    status: "order_created" as const,
    draftOrderId: draft.id,
    orderId: order.id,
    orderName: order.name,
    paymentMethod: settings.paymentMethod,
    financialStatus: order.displayFinancialStatus,
    total: actual.total,
    message:
      settings.paymentMethod === "free"
        ? `Order ${order.name} was placed at no cost. No payment was collected.`
        : `Order ${order.name} was placed for cash on delivery. Payment is still outstanding.`,
  }
}
function summaryFromQuote(quote: ShopifyOrderQuote) {
  return {
    subtotal: quote.subtotal,
    shipping: quote.shipping,
    tax: quote.tax,
    total: quote.total,
  }
}

export const shopifyOrderCreationTools: IntegrationTool[] = [
  {
    slug: "SHOPIFY_CREATE_ORDER",
    name: "Create order",
    description:
      "Prepare a Shopify-calculated order for explicit confirmation. Collect the buyer's email and delivery address (and phone when the merchant requires it). For item orders, supply numeric variant IDs and quantities from live products; for cart orders, the storefront reads the current cart. The merchant chooses online payment, cash on delivery or a free order; never promise a different payment method or invent prices. A checkout link is not proof of payment. Subscriptions use the store's checkout.",
    inputSchema: z.toJSONSchema(shopifyOrderInputSchema, { target: "draft-7" }),
  },
]
