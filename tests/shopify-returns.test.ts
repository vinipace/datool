import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { shopifyReturnFixture as fixture } from "./helpers/shopify-return"
import { getShopifyReturnOptions } from "@/src/server/build/integrations/shopify-return-options"
import { prepareShopifyReturn } from "@/src/server/build/integrations/shopify-return-quote"
import { shopifyActionSettingsSchema } from "@/src/lib/build/shopify"

test("return options verify ownership before pagination and never expose checkout proofs", async () => {
  const f = fixture()
  f.shopper.customerId = null
  await rejects(
    getShopifyReturnOptions({ orderId: f.input.orderId }, f.shopper, f.graphql),
    /checkout email or phone/
  )
  expect(f.calls).toHaveLength(0)
  await rejects(
    getShopifyReturnOptions(
      {
        orderId: f.input.orderId,
        orderNumber: "1001",
        email: "wrong@example.test",
      },
      f.shopper,
      f.graphql
    ),
    /No matching/
  )
  expect(f.calls).toHaveLength(1)
  const result = await getShopifyReturnOptions(
    { orderId: f.input.orderId, orderNumber: "1001", phone: "+15555551234" },
    f.shopper,
    f.graphql
  )
  expect(result.items.map((item) => item.fulfillmentLineItemId)).toEqual([
    "gid://shopify/FulfillmentLineItem/100",
    "gid://shopify/FulfillmentLineItem/101",
    "gid://shopify/FulfillmentLineItem/102",
  ])
  expect(JSON.stringify(result)).not.toContain("buyer@example.test")
  expect(JSON.stringify(result)).not.toContain("555")
  f.calls.length = 0
  await rejects(
    getShopifyReturnOptions(
      {
        orderId: f.input.orderId,
        orderNumber: "1001",
        phone: "+15555551234",
        email: "wrong@example.test",
      },
      f.shopper,
      f.graphql
    ),
    /No matching/
  )
  expect(f.calls).toHaveLength(1)
  f.shopper.customerId = "456"
  await rejects(
    getShopifyReturnOptions({ orderId: f.input.orderId }, f.shopper, f.graphql),
    /No matching/
  )
  f.shopper.customerId = "123"
  f.state.repeatCursor = true
  await rejects(
    getShopifyReturnOptions({ orderId: f.input.orderId }, f.shopper, f.graphql),
    /complete returnable items/
  )
})

test("return quotes enforce delivery windows, remaining quantities and merchant exchange policy before financial calculation", async () => {
  const f = fixture()
  const settings = shopifyActionSettingsSchema.parse({})
  f.state.deliveredAt = new Date(Date.now() - 31 * 86_400_000).toISOString()
  await rejects(
    prepareShopifyReturn(f.input, f.shopper, settings, f.graphql),
    /outside the store's return window/
  )
  f.state.deliveredAt = null
  await rejects(
    prepareShopifyReturn(f.input, f.shopper, settings, f.graphql),
    /confirmed delivery date/
  )
  f.state.quantity = 0
  await rejects(
    prepareShopifyReturn(
      f.input,
      f.shopper,
      { ...settings, returnWindowDays: null },
      f.graphql
    ),
    /quantity is no longer/
  )
  f.state.quantity = 2
  const replacements = [{ variantId: "60", quantity: 1 }]
  await rejects(
    prepareShopifyReturn(
      { ...f.input, replacements },
      f.shopper,
      settings,
      f.graphql
    ),
    /allows refunds only/
  )
  f.state.stock = 0
  await rejects(
    prepareShopifyReturn(
      { ...f.input, replacements },
      f.shopper,
      { ...settings, returnWindowDays: null, allowExchanges: true },
      f.graphql
    ),
    /replacement is unavailable/
  )
  expect(
    f.calls.some((call) => call.query.includes("DatoolCalculateReturn"))
  ).toBe(false)
  await rejects(
    prepareShopifyReturn(
      { ...f.input, items: [f.input.items[0], f.input.items[0]] },
      f.shopper,
      settings,
      f.graphql
    ),
    /duplicate return items/
  )
  await rejects(
    prepareShopifyReturn(
      { ...f.input, refundAmount: 1000 },
      f.shopper,
      settings,
      f.graphql
    )
  )
})

test("return quotes use Shopify amounts exactly and bind item selection and merchant settings", async () => {
  const f = fixture()
  const settings = shopifyActionSettingsSchema.parse({})
  const refund = await prepareShopifyReturn(
    f.input,
    f.shopper,
    settings,
    f.graphql
  )
  expect(refund.items).toEqual([{ title: "Board wax 101", quantity: 1 }])
  expect(refund.credit).toEqual({ amount: "19.7", currencyCode: "USD" })
  expect(refund.settlement).toEqual({
    direction: "refund",
    amount: "19.7",
    currencyCode: "USD",
  })
  const exchange = await prepareShopifyReturn(
    { ...f.input, replacements: [{ variantId: "60", quantity: 1 }] },
    f.shopper,
    { ...settings, allowExchanges: true },
    f.graphql,
    refund.operationId
  )
  expect(exchange.replacements).toEqual([
    { title: "Replacement wax (Large)", quantity: 1 },
  ])
  expect(exchange.settlement).toEqual({
    direction: "collect",
    amount: "0.4",
    currencyCode: "USD",
  })
  expect(exchange.fingerprint).not.toBe(refund.fingerprint)
  const policyChange = await prepareShopifyReturn(
    f.input,
    f.shopper,
    { ...settings, returnWindowDays: null },
    f.graphql,
    refund.operationId
  )
  expect(policyChange.fingerprint).not.toBe(refund.fingerprint)
  const calculate = f.calls.find((call) =>
    call.query.includes("DatoolCalculateReturn")
  )!
  expect(calculate.variables).toEqual({
    input: {
      orderId: "gid://shopify/Order/10",
      returnLineItems: [
        {
          fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/101",
          quantity: 1,
        },
      ],
      exchangeLineItems: [],
    },
  })
  f.state.currency = "EUR"
  await rejects(
    prepareShopifyReturn(f.input, f.shopper, settings, f.graphql),
    /inconsistent return amounts/
  )
})
