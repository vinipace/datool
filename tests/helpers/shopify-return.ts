import type { ShopifyGraphqlClient } from "@/src/server/build/integrations/shopify-catalog"

export function shopifyReturnFixture() {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = []
  const state = {
    customerId: "123",
    deliveredAt: new Date(Date.now() - 2 * 86_400_000).toISOString() as
      string | null,
    quantity: 2,
    stock: 10,
    repeatCursor: false,
    currency: "USD",
    returnedPrice: "19.99",
    replacementPrice: "20.00",
    transferAmount: "19.7",
    outstanding: "0.4",
    direction: "RefundReturnOutcome",
    refundStatus: "SUCCESS",
    lost: "" as "" | "create" | "process" | "invoice",
    created: 0,
    processed: 0,
    invoices: 0,
    foreignOutcome: false,
    foreignTransaction: false,
    omitMaximumRefundable: false,
    returnStatus: "OPEN",
    financialStatus: "PENDING",
    fullyPaid: false,
    cancelledAt: null as string | null,
    paymentUrl: "https://fixture.myshopify.com/orders/exchange-payment",
    returnSearch: "normal" as
      "normal" | "missing" | "duplicate" | "partial_marker" | "repeat_cursor",
    foreignReturn: false,
    partialProcessing: false,
    moreTransactions: false,
    guestEmail: "buyer@example.test",
  }
  const bag = (amount: string) => ({
    presentmentMoney: { amount, currencyCode: state.currency },
  })
  const line = (id: string, quantity: number) => ({
    quantity,
    fulfillmentLineItem: {
      id: `gid://shopify/FulfillmentLineItem/${id}`,
      lineItem: {
        id: `gid://shopify/LineItem/${id}`,
        name: `Board wax ${id}`,
        variant: { id: "gid://shopify/ProductVariant/50" },
      },
    },
  })
  let createdInput:
    | {
        returnLineItems: Array<{
          fulfillmentLineItemId: string
          quantity: number
          returnReasonNote: string
        }>
        exchangeLineItems: Array<{ variantId: string; quantity: number }>
      }
    | undefined
  const returned = () => ({
    id: `gid://shopify/Return/${state.created}`,
    status: state.returnStatus,
    order: {
      id: "gid://shopify/Order/10",
      name: "#1001",
      email: state.guestEmail,
      phone: "+15555551234",
      customer: {
        id: `gid://shopify/Customer/${state.foreignReturn ? "999" : state.customerId}`,
      },
      shippingAddress: null,
      totalOutstandingSet: bag(state.outstanding),
      displayFinancialStatus: state.financialStatus,
      fullyPaid: state.fullyPaid,
      cancelledAt: state.cancelledAt,
      paymentCollectionDetails: {
        additionalPaymentCollectionUrl: state.paymentUrl,
      },
    },
    returnLineItems: {
      nodes: (createdInput?.returnLineItems ?? []).map((line, i) => ({
        id: `gid://shopify/ReturnLineItem/${i + 1}`,
        quantity: line.quantity,
        processedQuantity: state.partialProcessing
          ? 99
          : state.processed
            ? line.quantity
            : 0,
        fulfillmentLineItem: { id: line.fulfillmentLineItemId },
        returnReasonNote: line.returnReasonNote,
      })),
      pageInfo: { hasNextPage: false },
    },
    exchangeLineItems: {
      nodes: (createdInput?.exchangeLineItems ?? []).map((line, i) => ({
        id: `gid://shopify/ExchangeLineItem/${i + 1}`,
        quantity: line.quantity,
        processedQuantity: state.processed ? line.quantity : 0,
        variantId: line.variantId,
      })),
      pageInfo: { hasNextPage: false },
    },
  })
  const transactions = () => ({
    nodes:
      state.processed &&
      state.direction === "RefundReturnOutcome" &&
      state.transferAmount !== "0"
        ? [
            {
              id: "gid://shopify/OrderTransaction/301",
              kind: "REFUND",
              status: state.refundStatus,
              amountSet: bag(state.transferAmount),
            },
          ]
        : [],
    pageInfo: { hasNextPage: state.moreTransactions },
  })
  const graphql: ShopifyGraphqlClient = async (query, options) => {
    const variables = options?.variables ?? {}
    calls.push({ query, variables })
    if (query.includes("DatoolFindCreatedReturn")) {
      const match = returned()
      const candidate = { id: match.id, returnLineItems: match.returnLineItems }
      if (state.returnSearch === "partial_marker")
        candidate.returnLineItems.nodes.forEach((line) => {
          line.returnReasonNote += "extra"
        })
      return Response.json({
        data: {
          order: {
            ...match.order,
            returns: {
              nodes:
                state.returnSearch === "missing" || !state.created
                  ? []
                  : state.returnSearch === "duplicate" && variables.after
                    ? [{ ...candidate, id: "gid://shopify/Return/999" }]
                    : variables.after || state.returnSearch === "duplicate"
                      ? [candidate]
                      : [],
              pageInfo: {
                hasNextPage:
                  state.returnSearch === "repeat_cursor" || !variables.after,
                endCursor: "next-return",
              },
            },
          },
        },
      })
    }
    if (query.includes("DatoolCheckCreatedReturn"))
      return Response.json({
        data: {
          return: state.created
            ? { ...returned(), transactions: transactions() }
            : null,
        },
      })
    if (query.includes("DatoolReturnOrder"))
      return Response.json({
        data: {
          order: {
            id: "gid://shopify/Order/10",
            name: "#1001",
            customer: { id: `gid://shopify/Customer/${state.customerId}` },
            email: "buyer@example.test",
            phone: "+1 (555) 555-1234",
            shippingAddress: null,
            currencyCode: "USD",
            presentmentCurrencyCode: "USD",
          },
        },
      })
    if (query.includes("DatoolReturnableFulfillments"))
      return Response.json({
        data: {
          returnableFulfillments: {
            nodes: [
              {
                id: variables.after
                  ? "gid://shopify/ReturnableFulfillment/30"
                  : "gid://shopify/ReturnableFulfillment/20",
                fulfillment: {
                  id: "gid://shopify/Fulfillment/20",
                  deliveredAt: state.deliveredAt,
                },
                returnableFulfillmentLineItems: {
                  nodes: [
                    line(variables.after ? "102" : "100", state.quantity),
                  ],
                  pageInfo: {
                    hasNextPage: !variables.after,
                    endCursor: "line-cursor",
                  },
                },
              },
            ],
            pageInfo: {
              hasNextPage: !variables.after,
              endCursor: "fulfillment-cursor",
            },
          },
        },
      })
    if (query.includes("DatoolReturnableLines"))
      return Response.json({
        data: {
          returnableFulfillment: {
            id: "gid://shopify/ReturnableFulfillment/20",
            returnableFulfillmentLineItems: {
              nodes: [line("101", state.quantity)],
              pageInfo: {
                hasNextPage: state.repeatCursor,
                endCursor: "line-cursor",
              },
            },
          },
        },
      })
    if (query.includes("DatoolReturnVariants"))
      return Response.json({
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/60",
              title: "Large",
              availableForSale: true,
              inventoryQuantity: state.stock,
              inventoryPolicy: "DENY",
              inventoryItem: { tracked: true },
              product: {
                title: "Replacement wax",
                status: "ACTIVE",
                publishedAt: "2020-01-01T00:00:00Z",
                requiresSellingPlan: false,
              },
            },
          ],
        },
      })
    if (query.includes("DatoolCalculateReturn")) {
      const input = variables.input as { exchangeLineItems: unknown[] }
      return Response.json({
        data: {
          returnCalculate: {
            returnLineItems: [
              {
                fulfillmentLineItem: {
                  id: "gid://shopify/FulfillmentLineItem/101",
                },
                quantity: 1,
                subtotalSet: bag(state.returnedPrice),
                totalTaxSet: bag("0.01"),
                restockingFee: { amountSet: bag("0.10") },
              },
            ],
            exchangeLineItems: input.exchangeLineItems.length
              ? [
                  {
                    variant: { id: "gid://shopify/ProductVariant/60" },
                    quantity: 1,
                    subtotalSet: bag(state.replacementPrice),
                    totalTaxSet: bag("0.10"),
                  },
                ]
              : [],
            returnShippingFee: {
              amountSet: bag("0.20"),
              taxAmountSet: bag("0.00"),
            },
          },
        },
      })
    }
    if (query.includes("DatoolCreateReturn")) {
      state.created++
      createdInput = variables.input as typeof createdInput
      if (state.lost === "create")
        throw new Error("Connection reset after Shopify created the return")
      return Response.json({
        data: { returnCreate: { return: returned(), userErrors: [] } },
      })
    }
    if (query.includes("DatoolReturnFinancialOutcome"))
      return Response.json({
        data: {
          return: {
            id: returned().id,
            order: {
              id: "gid://shopify/Order/10",
              name: "#1001",
              email: "buyer@example.test",
              phone: "+15555551234",
              shippingAddress: null,
              customer: {
                id: `gid://shopify/Customer/${state.foreignOutcome ? "999" : state.customerId}`,
              },
            },
            suggestedFinancialOutcome: {
              financialTransfer: {
                __typename: state.direction,
                amount: bag(state.transferAmount),
                suggestedTransactions: [
                  {
                    kind: "REFUND",
                    amountSet: bag(state.transferAmount),
                    maximumRefundableSet: state.omitMaximumRefundable
                      ? null
                      : bag("25.00"),
                    parentTransaction: {
                      id: "gid://shopify/OrderTransaction/300",
                      kind: state.foreignTransaction ? "AUTHORIZATION" : "SALE",
                    },
                  },
                ],
              },
            },
          },
        },
      })
    if (query.includes("DatoolProcessReturn")) {
      state.processed++
      if (state.lost === "process")
        throw new Error("Connection reset after Shopify processed the return")
      return Response.json({
        data: {
          returnProcess: {
            return: {
              ...returned(),
              transactions: transactions(),
            },
            userErrors: [],
          },
        },
      })
    }
    if (query.includes("DatoolInvoiceExchange")) {
      state.invoices++
      if (state.lost === "invoice")
        throw new Error("Connection reset after invoice")
      return Response.json({
        data: {
          orderInvoiceSend: {
            order: { id: "gid://shopify/Order/10" },
            userErrors: [],
          },
        },
      })
    }
    throw new Error("Unexpected Shopify request")
  }
  const shopper = {
    shop: "fixture.myshopify.com",
    customerId: "123" as string | null,
    browserSessionId: "browser",
  }
  const input = {
    orderId: "gid://shopify/Order/10",
    items: [
      {
        fulfillmentLineItemId: "gid://shopify/FulfillmentLineItem/101",
        quantity: 1,
      },
    ],
    reason: "Wrong size",
  }
  return { calls, state, graphql, shopper, input }
}
