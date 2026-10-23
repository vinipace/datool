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
    replacementOrderSubtotal: "25.00",
    replacementOrderTax: "2.50",
    replacementOrderTotals: { free: "27.50", paid: "32.50" },
    replacementOrderCurrency: "USD",
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
    holds: [
      {
        id: "gid://shopify/FulfillmentHold/501",
        reason: "AWAITING_PAYMENT",
        heldByRequestingApp: false,
        heldByApp: null,
      },
      {
        id: "gid://shopify/FulfillmentHold/502",
        reason: "INVENTORY_OUT_OF_STOCK",
        heldByRequestingApp: false,
        heldByApp: null,
      },
      {
        id: "gid://shopify/FulfillmentHold/503",
        reason: "AWAITING_PAYMENT",
        heldByRequestingApp: false,
        heldByApp: { id: "gid://shopify/App/999" },
      },
    ] as Array<{
      id: string
      reason: string
      heldByRequestingApp: boolean
      heldByApp: { id: string } | null
    }>,
    holdReleases: 0,
    loseHoldRelease: false,
    fulfillmentMode: "normal" as
      "normal" | "mixed" | "missing" | "repeat_cursor" | "expanded",
    changeAfterFulfillmentRead: "" as "" | "balance" | "owner",
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
    if (query.includes("DatoolOrderVariants"))
      return Response.json({
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/60",
              title: "Large",
              availableForSale: true,
              inventoryQuantity: state.stock,
              inventoryPolicy: "DENY",
              inventoryItem: { tracked: true, requiresShipping: true },
              product: {
                title: "Replacement wax",
                status: "ACTIVE",
                publishedAt: "2020-01-01T00:00:00Z",
                requiresSellingPlan: false,
              },
            },
          ],
          shop: { currencyCode: state.replacementOrderCurrency },
          paymentTermsTemplates: [],
        },
      })
    if (query.includes("DatoolCalculateOrder")) {
      const input = variables.input as {
        shippingLine?: { shippingRateHandle?: string }
      }
      const paidShipping = input.shippingLine?.shippingRateHandle === "ground"
      const orderBag = (amount: string) => ({
        presentmentMoney: {
          amount,
          currencyCode: state.replacementOrderCurrency,
        },
      })
      return Response.json({
        data: {
          draftOrderCalculate: {
            userErrors: [],
            calculatedDraftOrder: {
              subtotalPriceSet: orderBag(state.replacementOrderSubtotal),
              totalShippingPriceSet: orderBag(paidShipping ? "5.00" : "0.00"),
              totalTaxSet: orderBag(state.replacementOrderTax),
              totalPriceSet: orderBag(
                state.replacementOrderTotals[paidShipping ? "paid" : "free"]
              ),
              availableShippingRates: [
                {
                  handle: "ground",
                  title: "Ground",
                  price: {
                    amount: "5.00",
                    currencyCode: state.replacementOrderCurrency,
                  },
                },
              ],
              lineItems: [
                {
                  title: "Replacement wax",
                  variantTitle: "Large",
                  quantity: 1,
                },
              ],
              transformerFingerprint: null,
            },
          },
        },
      })
    }
    if (query.includes("DatoolExchangeFulfillment")) {
      const match = returned()
      const exchangeLines = match.exchangeLineItems.nodes.map((line, i) => ({
        ...line,
        lineItems: [
          { id: `gid://shopify/LineItem/${501 + i}`, quantity: line.quantity },
        ],
      }))
      const lines = exchangeLines.map((line) => ({
        lineItem: { id: line.lineItems[0].id },
        totalQuantity: line.quantity,
        remainingQuantity: line.quantity,
      }))
      if (state.fulfillmentMode === "mixed")
        lines.push({
          lineItem: { id: "gid://shopify/LineItem/999" },
          totalQuantity: 1,
          remainingQuantity: 1,
        })
      const unrelated = {
        id: "gid://shopify/FulfillmentOrder/902",
        status: "ON_HOLD",
        fulfillmentHolds: [
          {
            id: "gid://shopify/FulfillmentHold/504",
            reason: "AWAITING_PAYMENT",
            heldByRequestingApp: false,
            heldByApp: null,
          },
        ],
        lineItems: {
          nodes: [
            {
              lineItem: { id: "gid://shopify/LineItem/999" },
              totalQuantity: 1,
              remainingQuantity: 1,
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      }
      const relevant = {
        id: "gid://shopify/FulfillmentOrder/901",
        status: state.holds.length ? "ON_HOLD" : "OPEN",
        fulfillmentHolds: [...state.holds],
        lineItems: { nodes: lines, pageInfo: { hasNextPage: false } },
      }
      if (state.changeAfterFulfillmentRead === "balance") {
        state.outstanding = "0.4"
        state.fullyPaid = false
        state.financialStatus = "PENDING"
      } else if (state.changeAfterFulfillmentRead === "owner")
        state.foreignReturn = true
      return Response.json({
        data: {
          return: {
            ...match,
            exchangeLineItems: {
              nodes: exchangeLines,
              pageInfo: { hasNextPage: false },
            },
            order: {
              ...match.order,
              fulfillmentOrders: {
                nodes: !variables.after
                  ? [unrelated]
                  : state.fulfillmentMode === "missing"
                    ? []
                    : state.fulfillmentMode === "expanded"
                      ? [
                          relevant,
                          {
                            ...relevant,
                            id: "gid://shopify/FulfillmentOrder/903",
                          },
                        ]
                      : [relevant],
                pageInfo: {
                  hasNextPage:
                    !variables.after ||
                    state.fulfillmentMode === "repeat_cursor",
                  endCursor: "exchange-page",
                },
              },
            },
          },
        },
      })
    }
    if (query.includes("DatoolReleaseExchangeHolds")) {
      state.holdReleases++
      const ids = variables.holdIds as string[]
      state.holds = state.holds.filter((hold) => !ids.includes(hold.id))
      if (state.loseHoldRelease) throw new Error("Lost release response")
      return Response.json({
        data: {
          fulfillmentOrderReleaseHold: {
            fulfillmentOrder: {
              id: variables.id,
              fulfillmentHolds: state.holds,
            },
            userErrors: [],
          },
        },
      })
    }
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
