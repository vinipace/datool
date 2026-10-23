# Shopify customer journey actions

Implementation checklist for PR #36. The reference is [Chatbase's native Shopify actions](https://www.chatbase.co/docs/user-guides/chatbot/actions/shopify-actions), checked 23 October 2026. A checked implementation item is not evidence that a production store has granted its permissions.

## Delivery checklist

- [x] Bind customer authorization to authenticated channel messages and recheck identity before each action.
- [x] Product discovery, variant IDs, stock filtering and product cards with cart controls.
- [ ] Catalog image search, complete variant browsing and messaging-channel cart support from Chatbase's documented action matrix.
- [x] Read and update the shopper's storefront cart; retain chat state during navigation.
- [ ] Online checkout, cash on delivery and free orders, with merchant-selected payment policies.
- [x] Shopify-calculated quotes and one-shot creation of online-payment drafts, unpaid cash-on-delivery orders and zero-total free orders.
- [x] Durable approved order intent and on-demand checkout recovery/payment status for the verified shopper.
- [ ] Payment completion tracking, cart clearing after confirmed placement, reconciliation of interrupted writes and messaging-channel order creation.
- [x] Own order history, status and tracking; guest lookup by order number and checkout email or phone.
- [x] Merchant-allowlisted order tags.
- [x] Account activation and sign-in guidance appropriate to the store's account system.
- [x] Update the authenticated customer's profile and default account address.
- [x] Confirmed original-order return/refund and exchange processing, delivery-window policy and original-payment settlement.
- [ ] Return recovery/reconciliation, changed-balance resolution and payment-verified exchange hold release.
- [ ] Replacement orders with mandatory human approval and original-order credit accounting.
- [ ] Action settings, confirmations, error states and reusable chat controls.
- [ ] Delayed teammate approval and customer re-verification when the Shopify session has expired.
- [ ] Required/optional scope configuration, protected customer data approval and reconnect guidance.
- [ ] Behavioral authorization, policy, idempotency and UI tests; Shopify schema validation.
- [ ] Update this PR and verify a controlled sandbox install after release.

## Authorization and execution contract

The model must never choose the authenticated customer. Shopify's signed app proxy identifies the customer; a server-only record binds the admitted message to the browser identity version. Runtime actions resolve that record through their durable channel job and turn. Logout, account switching, connection revocation, a different store, and missing authentication fail closed. Public message metadata is not an authorization source.

Guest order proofs grant access to one matching order, not a customer account. Responses omit unrelated personal data. Mutations validate ownership immediately before dispatch, enforce merchant settings on the server, and use the existing durable tool ledger. An ambiguous external write is never automatically replayed. Approval resumes use the pinned original action and input, not a visitor-supplied approval flag.

Cart operations execute against the current storefront session using a bounded, origin-checked bridge. The existing runtime stores the approved, immutable command and a one-shot continuation; the shopper clicks Show cart or Update cart on the storefront. Locale-aware Shopify Ajax endpoints read the cart, add variants and set/remove existing lines. Only a sanitized display snapshot returns to Datool: cart tokens, notes, attributes and line properties stay in the store.

Cart writes require browser storage and Web Locks. A receipt is saved before dispatch and reused across clicks, reloads and tabs; a lost response or Shopify inventory error never causes an automatic replay. Each command expires after one hour, allowing old receipts to be removed. Unsupported browsers can use the store's cart directly. A `datool:cart:updated` DOM event provides the refreshed snapshot for themes that want to update their cart badge or drawer; themes must subscribe to it. These receipts prevent accidental replay, not deliberate same-origin storage tampering by a shopper.

Product cards use live catalog results, including product type/vendor/price filters, stock availability and product-page cursors. The merchant's stock exclusion setting cannot be weakened by model arguments. A card can offer cart selection only when exactly one enabled, non-private Update shopping cart action is available for the same store and channel. Its saved, expiring selection permits only the variants actually shown; selecting it runs the existing cart action and merchant approval path. It does not itself claim the cart was changed. Card selection, approval and browser cart completion reuse the existing tool records, without another queue or persistence table.

Large variant collections currently show the first matching page and link to the store's complete options. Full in-chat variant browsing, catalog image search and messaging-channel cart support remain unfinished. Prices use the store's base currency and are re-evaluated by Shopify when the cart changes.

Shopify calculates prices, discounts, shipping, taxes and payment status. Browser cart totals are untrusted display data and must never authorize refunds, order prices or payment. The cart's Checkout link navigates to Shopify checkout; it does not create or prove a completed/paid order. Updating an account address does not change a placed order's delivery address.

Create order obtains its payment method, item source, phone requirement, tags and note from merchant settings. The native adapter only sends live variant IDs and quantities to Shopify's draft-order calculation; it does not accept model-supplied prices. Physical goods require an address and an available Shopify shipping rate. The confirmation shows the Shopify subtotal, shipping, tax, total and payment behavior. A changed or expired quote requires a new confirmation or teammate approval before any order write.

Online payment returns Shopify's invoice checkout URL without completing or marking the order paid. Cash on delivery uses Shopify receipt payment terms and verifies the completed order remains unpaid. Free orders apply the merchant-authorized discount and free delivery, then require Shopify's total to be zero. A draft whose creation response differs from the confirmed totals is retained for review without completion.

Approved order intent, settings, operation tags and available draft/order IDs survive failed tool responses in a dedicated commerce table. Metering remains separate. An interrupted or uncertain attempt blocks a new order in the same conversation. Check checkout reads the saved draft/order ID, or searches the exact operation tag when the create response was lost. Missing search results never authorize a new order. An unambiguous online draft with matching buyer and totals recovers its existing unpaid checkout link. A completed draft recovers the placed order and current payment status; refunded or pending orders are not reported as paid. Logged-in customers can check their conversation on another verified device; guest access remains bound to the original browser session. Arbitrary external draft/order/customer IDs are not tool arguments.

Recovery performs no Shopify writes. An uncompleted cash-on-delivery/free draft, mismatched buyer/totals, or duplicate operation tag stays blocked for store-team review. A later check can recognize the original order after the store team completes it in Shopify. Supported in-chat resolution of incomplete or missing drafts, automatic payment notifications and webhook reconciliation remain release requirements. A stale read cannot overwrite a newer recorded outcome.

Cart-based drafts currently support ordinary variant lines. The storefront bridge flags subscriptions, line properties and bundle relationships without sending their private contents to Datool. Those carts, and carts from an older bridge that cannot establish this flag, use the store checkout to preserve their options. The remaining journey work includes cart clearing only after verified placement and payment-completion notifications; issuing a checkout link alone cannot trigger either.

Existing abuse protections remain burst-oriented. This work does not add default daily message quotas or spending caps.

## Release gates

Public apps require Shopify approval for protected customer/order data. Access to orders older than 60 days additionally requires `read_all_orders` approval. Added permissions require merchant consent. Development-store validation, merged code, production deployment, permission grants and end-to-end verification are separate checks.

Order creation additionally requests `write_draft_orders` and `read_payment_terms`, alongside product and order reads. Existing installations must reconnect and consent; a local scope declaration does not grant access. The installation instructions list the complete configured scopes.

Apply migration 0065 after 0064 for durable order operations. Check checkout requires draft-order, order and customer reads (the corresponding granted write scopes include read access). Public protected customer data approval is still required.

## Verification recorded so far

The first implementation slice has six behavioral tests covering message-bound identity, account changes, tag policies, guest order proofs, account activation and one-shot customer confirmation. The confirmation regression fails on the prior runtime because it dispatches the change before consent. Seven Chromium story tests cover the confirmation and integration controls. Order/customer GraphQL operations validate against Shopify 2026-10. These are local checks; production still needs the new release and customer/order permissions.

The cart slice adds real-runtime database tests for both model calls and multi-step procedures: merchant approval precedes the browser command, replacement input is ignored, one usage record is produced on completion, and a consumed continuation cannot be reused. The host-script test covers origin/source checks, localization, private-field removal, duplicate/reload protection and ambiguous writes. Eighteen focused Shopify/bridge tests and ten Chromium chat stories pass locally. Cart populated, empty, keyboard-focus and error states were inspected at mobile and desktop widths; the draft message survives cart interactions.

Those full-path tests exposed an incompatible JSON Schema dialect in the new native customer/order tools. Their published schemas now target Draft 7, matching Datool's runtime validator. Regression checks demonstrated failures before the schema, composer-draft, procedure-cart and next-turn model-context fixes, then passed after repair. The existing generic approval/continuation checks remain required. No new Shopify GraphQL operations were introduced by the cart slice, and live-store cart verification is still pending release.

The product-card slice exercises seven real-runtime cart paths, including product searches through model tools, keyword procedures, intent procedures and approved reads. They verify public card delivery, allowed variant selection, preserved merchant approval and one-shot completion. The regressions exposed missing procedure metadata, raw catalog JSON in approved replies and dropped card-only outbound messages; each failed before its repair. Six commerce tests cover Shopify adapters and published input schemas, including stock/price filtering across variant pages. Fifteen Chromium stories cover the chat and integration controls. Product images, mobile/desktop layout, keyboard focus, empty results and network errors were inspected. The product and variant GraphQL queries validate against Shopify 2026-10. These checks do not establish a live Shopify installation.

Order creation has six real-runtime database cases spanning all three payment modes and both item sources. They exercise guest checkout, customer-bound orders, required delivery phones, stock checks, untrusted cart totals, price changes, immutable confirmation input, merchant approval and one-shot continuation consumption. Lost create/completion responses retain uncertain state and the available external identifiers. A new model call cannot bypass that state, and a changed creation total does not complete the order. The uncertainty and custom-cart regressions were demonstrated failing before their repairs. Browser stories cover merchant order settings and all three confirmation labels and summaries. The draft-order calculation, creation and completion operations validate against Shopify Admin GraphQL 2026-10. Live-store order/payment outcomes remain unverified.

The same runtime cases exercise checkout recovery through an enabled native action: unknown and other-customer/browser operation IDs cause no Shopify read; a customer's second verified device can read the same conversation; pending, paid and refunded payment responses stay distinct. Missing search results, partial tags, duplicate matches and mismatched buyers do not clear an uncertain order. Lost online create responses recover the original checkout link, and lost completion responses recover the original order without another create/complete mutation. A database fault after Shopify success originally surfaced as a failed action; the regression demonstrated that failure before the repair and now requires an uncertain outcome and recovery without another write. Recovery queries validate against Shopify Admin GraphQL 2026-10. These provider responses are fixtures, not live payment evidence.

## Return processing

Returns use the same order-ownership check as order lookup. A signed-in customer
must own the order; a guest supplies its number and checkout email or phone.
Returnable fulfillment lines are paginated and checked against remaining
quantities and the merchant's delivery-based window. Missing delivery dates
require store-team review when a window is set. Replacement stock is checked
live. Shopify calculates the quote, which is refreshed before the approved
operation starts. The shared chat confirmation and Inbox approval paths retain
server-owned input; altered or expired quotes require consent again.

The existing commerce ledger now records return intent and the external return
ID. Admission is serialized by original order across conversations, without
holding a database transaction during Shopify requests. Processing uses only
Shopify's suggested original payment transactions, the approved exact balance,
and `allowOverRefunding: false`. The optional maximum-refund field is checked
when supplied; its documented absence does not reject an otherwise valid refund.
No model-supplied amount, refund destination, physical receipt or restocking
instruction is accepted. Pending refunds and successful provider transactions
remain distinct. Payable exchanges send a Shopify invoice and retain Shopify's
fulfillment hold. The final outstanding order balance must match the approved
exchange amount before sending an invoice, so an unrelated unpaid balance is
not silently added to the payment request.

The current runtime checks cover five settlement modes, guest proof, teammate
approval, quote changes, pinned input, changed owner/balance/payment suggestions,
lost create/process/invoice responses, and database failure before recording a
return ID or final result. A second conversation cannot repeat an unresolved
return. Adapter checks cover pagination, return-window and quantity validation,
stock/exchange policy, exact decimal amounts and currency consistency. Browser
stories cover the shared confirmation and merchant settings. The generated
queries validate against Shopify Admin GraphQL 2026-10. These are local tests
with stubbed provider responses, not live refunds or payments.

Apply migration 0066 and obtain `write_returns` plus the invoice/order scopes
before enabling the action. Remaining return work includes recovering unresolved
operations, re-confirming a balance changed after return creation, payment
webhooks and verified hold release. Separate replacement orders and their credit
accounting are not implemented. Full after-sales parity remains incomplete.

## Design review

The implementation deliberately reuses the Shopify SDK, Datool's action runtime, durable tool records, existing continuation storage and Inbox approvals. Customer confirmation and teammate approval now share one persistence path while retaining separate authorization rules. The mutation helper owns common Shopify error handling; callers describe only their action-specific response. The simplification is covered by four commerce tests and seven runtime tests for confirmation, approval, continuation and handoff behavior.

Order recovery uses one commerce record per approved intent because a terminal tool result clears its continuation, while usage events deliberately exclude order arguments and customer addresses. Admission locks only the database transaction, never a network request. The creation and recovery paths share money normalization and draft totals rather than implementing different comparison rules.

Keep the server-owned message identity record and the ownership recheck immediately before writes. Removing those checks would let untrusted chat input or stale account identity influence customer access. Keep ambiguous writes distinguishable from failures; a shorter automatic retry path could repeat a change that Shopify already applied.

For the remaining actions, Shopify remains responsible for prices, discounts, shipping, tax and payment state. Use the existing continuation mechanism for storefront interactions instead of introducing another queue or workflow engine. Order and return processing consume the same merchant settings and confirmation infrastructure. Return and order intent share the commerce ledger rather than separate queues or persistence systems.

Before financial actions are considered ready, validate delayed approvals across the five-minute identity freshness boundary, provide an explicit re-verification path, and test reconciliation after ambiguous external writes. Complete privacy/uninstall handling and scope/reconnect guidance, then verify the full customer journey in the sandbox. Passing the current unit and database tests does not replace those release checks.
