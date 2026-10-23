import { expect, test } from "bun:test"
import { rejects } from "node:assert/strict"
import { readShopifyOrders } from "@/src/server/build/integrations/shopify-orders"
import type { ShopifyGraphqlClient } from "@/src/server/build/integrations/shopify-catalog"
import { runShopifyCustomerTool as executeCustomerTool } from "@/src/server/build/integrations/shopify-customers"
import { tagShopifyOrder } from "@/src/server/build/integrations/shopify-order-tags"
import { shopifyActionSettingsSchema } from "@/src/lib/build/shopify"
import { ShopifyWriteUncertainError } from "@/src/server/build/integrations/shopify-mutation"

const runShopifyCustomerTool = (
  ...args: [
    string,
    Record<string, unknown>,
    Parameters<typeof executeCustomerTool>[2],
    ShopifyGraphqlClient,
    () => Promise<void>,
  ]
) => executeCustomerTool(...args, async () => true)

test("profile and account address writes only target the verified shopper and preserve uncertain outcomes", async () => {
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: "123",
    browserSessionId: "browser",
  }
  const writes: Record<string, unknown>[] = []
  let wrongCustomer = false
  let timeout = false
  let revoked = false
  const beforeWrite = async () => {
    if (revoked) throw new Error("Session revoked")
  }
  const graphql: ShopifyGraphqlClient = async (query, options) => {
    if (query.includes("query DatoolDefaultAddress"))
      return Response.json({
        data: {
          customer: {
            id: `gid://shopify/Customer/${wrongCustomer ? "999" : "123"}`,
            defaultAddress: { id: "gid://shopify/MailingAddress/10" },
          },
        },
      })
    writes.push(options?.variables ?? {})
    if (timeout) throw new Error("Network failure after sending request")
    if (query.includes("mutation DatoolUpdateCustomer"))
      return Response.json({
        data: {
          customerUpdate: {
            customer: { id: "gid://shopify/Customer/123" },
            userErrors: [],
          },
        },
      })
    if (query.includes("mutation DatoolUpdateAddress"))
      return Response.json({
        data: {
          customerAddressUpdate: {
            address: { id: "gid://shopify/MailingAddress/10" },
            userErrors: [],
          },
        },
      })
    throw new Error("Unexpected operation")
  }
  await rejects(
    runShopifyCustomerTool(
      "SHOPIFY_UPDATE_PROFILE",
      { firstName: "Alice" },
      { ...shopper, customerId: null },
      graphql,
      beforeWrite
    ),
    /Sign in/
  )
  await rejects(
    runShopifyCustomerTool(
      "SHOPIFY_UPDATE_PROFILE",
      { firstName: "Alice", id: "gid://shopify/Customer/999" },
      shopper,
      graphql,
      beforeWrite
    )
  )
  expect(writes).toEqual([])
  expect(
    await runShopifyCustomerTool(
      "SHOPIFY_UPDATE_PROFILE",
      { firstName: "Alice" },
      shopper,
      graphql,
      beforeWrite
    )
  ).toMatchObject({ status: "updated" })
  expect(writes).toEqual([
    { input: { firstName: "Alice", id: "gid://shopify/Customer/123" } },
  ])
  const address = {
    firstName: "Alice",
    lastName: "Buyer",
    address1: "123 Main St",
    city: "Austin",
    provinceCode: "TX",
    countryCode: "US",
    zip: "78701",
  }
  wrongCustomer = true
  await rejects(
    runShopifyCustomerTool(
      "SHOPIFY_UPDATE_ADDRESS",
      address,
      shopper,
      graphql,
      beforeWrite
    ),
    /verified/
  )
  expect(writes).toHaveLength(1)
  wrongCustomer = false
  const updatedAddress = await runShopifyCustomerTool(
    "SHOPIFY_UPDATE_ADDRESS",
    address,
    shopper,
    graphql,
    beforeWrite
  )
  expect(updatedAddress.status).toBe("updated")
  expect(updatedAddress.message).toContain("Existing orders")
  expect(writes[1]).toEqual({
    customerId: "gid://shopify/Customer/123",
    addressId: "gid://shopify/MailingAddress/10",
    address,
  })
  revoked = true
  await rejects(
    runShopifyCustomerTool(
      "SHOPIFY_UPDATE_PROFILE",
      { firstName: "New" },
      shopper,
      graphql,
      beforeWrite
    ),
    /revoked/
  )
  expect(writes).toHaveLength(2)
  revoked = false
  timeout = true
  await rejects(
    runShopifyCustomerTool(
      "SHOPIFY_UPDATE_PROFILE",
      { firstName: "New" },
      shopper,
      graphql,
      beforeWrite
    ),
    ShopifyWriteUncertainError
  )
  expect(writes).toHaveLength(3)
})

test("order tagging enforces merchant tags and customer ownership before dispatch", async () => {
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: "123",
    browserSessionId: "browser",
  }
  const settings = shopifyActionSettingsSchema.parse({
    allowedOrderTags: ["support-requested"],
  })
  const input = {
    orderId: "gid://shopify/Order/1",
    tags: ["support-requested"],
  }
  let owner = "999"
  let writes = 0
  const graphql: ShopifyGraphqlClient = async (query) => {
    if (query.includes("query DatoolOrderOwner"))
      return Response.json({
        data: {
          order: {
            id: input.orderId,
            customer: { id: `gid://shopify/Customer/${owner}` },
          },
        },
      })
    writes++
    return Response.json({
      data: { tagsAdd: { node: { id: input.orderId }, userErrors: [] } },
    })
  }
  await rejects(
    tagShopifyOrder(input, shopper, settings, graphql, async () => {}),
    /accessible/
  )
  owner = "123"
  await rejects(
    tagShopifyOrder(
      { ...input, tags: ["refund-approved"] },
      shopper,
      settings,
      graphql,
      async () => {}
    ),
    /allowed/
  )
  expect(writes).toBe(0)
  expect(
    await tagShopifyOrder(input, shopper, settings, graphql, async () => {})
  ).toMatchObject({ status: "updated" })
  expect(writes).toBe(1)
})

test("account activation respects account versions and does not enumerate emails", async () => {
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: null,
    browserSessionId: "browser",
  }
  let version = "NEW_CUSTOMER_ACCOUNTS"
  let exists = true
  const invites: unknown[] = []
  const graphql: ShopifyGraphqlClient = async (query, options) => {
    if (query.includes("query DatoolAccountSettings"))
      return Response.json({
        data: {
          shop: {
            customerAccounts: "OPTIONAL",
            customerAccountsV2: { customerAccountsVersion: version, url: null },
            primaryDomain: { url: "https://fixture.myshopify.com" },
          },
        },
      })
    if (query.includes("query DatoolAccountLookup"))
      return Response.json({
        data: {
          customers: {
            nodes: exists
              ? [
                  {
                    id: "gid://shopify/Customer/123",
                    defaultEmailAddress: { emailAddress: "buyer@example.test" },
                    state: "DISABLED",
                  },
                ]
              : [],
          },
        },
      })
    invites.push(options?.variables)
    return Response.json({
      data: {
        customerSendAccountInviteEmail: {
          customer: { id: "gid://shopify/Customer/123" },
          userErrors: [],
        },
      },
    })
  }
  const run = () =>
    runShopifyCustomerTool(
      "SHOPIFY_ACTIVATE_ACCOUNT",
      { email: "buyer@example.test" },
      shopper,
      graphql,
      async () => {}
    )
  expect(await run()).toMatchObject({
    status: "sign_in",
    url: "https://fixture.myshopify.com/account/login",
  })
  expect(invites).toHaveLength(0)
  version = "CLASSIC"
  const known = await run()
  expect(invites).toEqual([{ customerId: "gid://shopify/Customer/123" }])
  exists = false
  expect(await run()).toEqual(known)
  expect(invites).toHaveLength(1)
})

test("order lookup verifies each returned order, isolates guest proofs and never discloses checkout contact data", async () => {
  const own = {
    id: "gid://shopify/Order/1",
    name: "#1001",
    createdAt: "2026-10-20T12:00:00Z",
    customer: { id: "gid://shopify/Customer/123" },
    email: "buyer@example.test",
    phone: "+15555551234",
    shippingAddress: { phone: "+15555551234" },
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "FULFILLED",
    currentTotalPriceSet: {
      presentmentMoney: { amount: "50.00", currencyCode: "USD" },
    },
    lineItems: {
      nodes: [
        {
          id: "gid://shopify/LineItem/1",
          name: "Board",
          quantity: 1,
          variant: { id: "gid://shopify/ProductVariant/1" },
          image: null,
        },
      ],
      pageInfo: { hasNextPage: false },
    },
    fulfillments: [
      {
        status: "SUCCESS",
        deliveredAt: null,
        trackingInfo: [
          {
            number: "TRACK1",
            company: "Carrier",
            url: "https://tracking.example.test/1",
          },
          { number: "INVALID", company: "Carrier", url: "javascript:alert(1)" },
        ],
      },
    ],
  }
  let requests = 0
  const graphql: ShopifyGraphqlClient = async () => {
    requests++
    // Simulate broad provider search results: the integration must still enforce ownership.
    return Response.json({
      data: {
        orders: {
          nodes: [
            own,
            {
              ...own,
              id: "gid://shopify/Order/2",
              name: "#2002",
              email: "someoneelse@example.test",
              phone: null,
              shippingAddress: null,
              customer: { id: "gid://shopify/Customer/999" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    })
  }
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: "123",
    browserSessionId: "browser",
  }
  const history = await readShopifyOrders({}, shopper, graphql)
  expect(history.orders).toHaveLength(1)
  expect(history.orders?.[0]).toMatchObject({
    id: own.id,
    paymentStatus: "PAID",
    fulfillments: [
      {
        trackingInfo: [
          { url: "https://tracking.example.test/1" },
          { url: null },
        ],
      },
    ],
  })
  expect(JSON.stringify(history)).not.toContain("buyer@example.test")
  expect(JSON.stringify(history)).not.toContain("5555551234")
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "2002", email: "someoneelse@example.test" },
        shopper,
        graphql
      )
    ).orders
  ).toEqual([])
  const guest = { ...shopper, customerId: null }
  const before = requests
  expect((await readShopifyOrders({}, guest, graphql)).status).toBe(
    "verification_required"
  )
  expect(requests).toBe(before)
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "1001", email: "BUYER@example.test" },
        guest,
        graphql
      )
    ).orders
  ).toHaveLength(1)
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "1001", phone: "+1 (555) 555-1234" },
        guest,
        graphql
      )
    ).orders
  ).toHaveLength(1)
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "1001", phone: "55551234" },
        guest,
        graphql
      )
    ).orders
  ).toEqual([])
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "1001", email: "buyer@example.test", phone: "55551234" },
        guest,
        graphql
      )
    ).orders
  ).toEqual([])
  expect(
    (
      await readShopifyOrders(
        { orderNumber: "2002", email: "buyer@example.test" },
        guest,
        graphql
      )
    ).orders
  ).toEqual([])
  await rejects(readShopifyOrders({ customerId: "999" }, shopper, graphql))
  await rejects(
    readShopifyOrders(
      { orderNumber: "1001 OR status:open", email: "buyer@example.test" },
      guest,
      graphql
    )
  )
})

test("published Shopify tool schemas accept documented inputs in the runtime validator", async () => {
  const { shopifyTools } =
    await import("@/src/server/build/integrations/shopify-tools")
  const { validateSchema } = await import("@/src/server/playground/schema")
  const examples = [
    [
      "SHOPIFY_SEARCH_PRODUCTS",
      { query: "board", maxPrice: 50, inStockOnly: true },
    ],
    [
      "SHOPIFY_GET_ORDERS",
      { orderNumber: "1001", email: "buyer@example.test" },
    ],
    ["SHOPIFY_UPDATE_PROFILE", { firstName: "Alice" }],
    [
      "SHOPIFY_UPDATE_ADDRESS",
      { address1: "123 Main St", city: "Austin", countryCode: "US" },
    ],
    ["SHOPIFY_ACTIVATE_ACCOUNT", { email: "buyer@example.test" }],
    [
      "SHOPIFY_TAG_ORDER",
      { orderId: "gid://shopify/Order/123", tags: ["support"] },
    ],
    [
      "SHOPIFY_UPDATE_CART",
      { operation: "add", items: [{ variantId: "123", quantity: 1 }] },
    ],
  ] as const
  for (const [slug, input] of examples) {
    const tool = shopifyTools.find((tool) => tool.slug === slug)
    if (!tool) throw new Error(`Missing native tool ${slug}`)
    expect(() => validateSchema(tool.inputSchema, input)).not.toThrow()
  }
})

test("live product search filters published products and finds available matching variants beyond the first page", async () => {
  const { runShopifyStoreTool } =
    await import("@/src/server/build/integrations/shopify-catalog")
  const calls: Array<Record<string, unknown>> = []
  const variant = (id: string, price: string, availableForSale: boolean) => ({
    id: `gid://shopify/ProductVariant/${id}`,
    title: `Size ${id}`,
    price,
    availableForSale,
  })
  const product = {
    id: "gid://shopify/Product/10",
    title: "Board",
    description: "A board",
    handle: "board",
    status: "ACTIVE",
    publishedAt: "2020-01-01T00:00:00Z",
    onlineStoreUrl: null,
    priceRangeV2: {
      minVariantPrice: { amount: "20" },
      maxVariantPrice: { amount: "100" },
    },
    variants: {
      nodes: [variant("11", "20", false)],
      pageInfo: { hasNextPage: true, endCursor: "variants-next" },
    },
  }
  const graphql = async (
    _query: string,
    options?: { variables?: Record<string, unknown> }
  ) => {
    const args = options?.variables ?? {}
    calls.push(args)
    if (args.id)
      return Response.json({
        data: {
          product: {
            variants: {
              nodes: [variant("12", "35", true), variant("13", "100", true)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      })
    return Response.json({
      data: {
        shop: {
          currencyCode: "USD",
          primaryDomain: { url: "https://store.example" },
        },
        products: {
          nodes: [
            product,
            { ...product, id: "gid://shopify/Product/20", publishedAt: null },
            { ...product, id: "gid://shopify/Product/30", status: "DRAFT" },
          ],
          pageInfo: { hasNextPage: true, endCursor: "products-next" },
        },
      },
    })
  }
  const result = await runShopifyStoreTool(
    "products",
    {
      query: "board",
      productType: 'Boards" OR status:draft',
      maxPrice: 50,
      after: "previous-page",
      inStockOnly: false,
    },
    graphql,
    { excludeOutOfStock: true }
  )
  if (!result.products) throw new Error("Expected product results")
  expect(result.nextCursor).toBe("products-next")
  expect(result.products).toHaveLength(1)
  expect(result.products[0]).toMatchObject({
    url: "https://store.example/products/board",
    optionsTruncated: true,
    variants: [{ cartVariantId: "12", price: "35", availableForSale: true }],
  })
  expect(calls).toHaveLength(2)
  expect(calls[0]).toMatchObject({ after: "previous-page" })
  expect(calls[0].query).toContain('product_type:"Boards\\" OR status:draft"')
  expect(calls[0].query).toContain("price:<=50")
  await rejects(
    runShopifyStoreTool(
      "products",
      { query: "board", minPrice: 60, maxPrice: 50 },
      graphql
    )
  )
})
