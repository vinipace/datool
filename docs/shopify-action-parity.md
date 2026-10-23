# Shopify customer journey actions

Implementation checklist for PR #36. The reference is [Chatbase's native Shopify actions](https://www.chatbase.co/docs/user-guides/chatbot/actions/shopify-actions), checked 23 October 2026. A checked implementation item is not evidence that a production store has granted its permissions.

## Immediate release scope

Feature expansion is frozen. Verify connection, product/policy answers and cards,
storefront cart/checkout navigation, verified order lookup and chat continuity.
Preserve abuse-only defaults without daily quotas. Finish lifecycle/privacy
requirements and sandbox proof before adding more commerce behavior.

Separate replacement exchanges are unavailable in the action catalog and are
rejected at execution, including previously saved definitions. Image-based
catalog discovery is deferred. Shopify actions now use the existing
WhatsApp and Telegram adapters as well as web chat. Existing order/return code remains
subject to merchant permissions and its documented verification requirements.

Uninstall revocation and encrypted privacy-request intake use the existing webhook
endpoint. Privacy fulfillment is an operator workflow, described in
[Shopify privacy operations](shopify-privacy.md); receiving a request does not
complete export or erasure. Public launch still requires fulfillment proof and
production subscription registration.

## Delivery checklist

- [x] Bind customer authorization to authenticated channel messages and recheck identity before each action.
- [x] Product discovery, variant IDs, stock filtering and product cards with cart controls.
- [x] Complete variant browsing through live product-card pages in storefront chat.
- [ ] Catalog image search.
- [x] Product links, conversation carts, guest order proofs and one-shot customer confirmations on WhatsApp and Telegram, using the shared runtime and durable channel outbox.
- [x] Read and update the shopper's storefront cart; retain chat state during navigation.
- [ ] Online checkout, cash on delivery and free orders, with merchant-selected payment policies.
- [x] Shopify-calculated quotes and one-shot creation of online-payment drafts, unpaid cash-on-delivery orders and zero-total free orders.
- [x] Durable approved order intent and on-demand checkout recovery/payment status for the verified shopper.
- [x] Automatic checkout/return payment reconciliation and deduplicated storefront conversation updates.
- [x] Remove purchased quantities from the original browser cart after verified placement/payment.
- [ ] Resolution of incomplete drafts and messaging-channel order creation.
- [x] Own order history, status and tracking; guest lookup by order number and checkout email or phone.
- [x] Merchant-allowlisted order tags.
- [x] Account activation and sign-in guidance appropriate to the store's account system.
- [x] Update the authenticated customer's profile and default account address.
- [x] Confirmed original-order return/refund and exchange processing, delivery-window policy and original-payment settlement.
- [x] Recover an original return and its confirmed refund/payment status without repeating Shopify writes.
- [x] Freshly approved continuation of an existing never-processed return, including a changed balance.
- [x] On-demand payment-verified release of the original recorded exchange payment holds.
- [ ] Replacement orders with mandatory human approval and original-order credit accounting.
- [ ] Action settings, confirmations, error states and reusable chat controls.
- [x] Delayed teammate approval and customer re-verification when the Shopify session has expired.
- [ ] Required/optional scope configuration, protected customer data approval and reconnect guidance.
- [ ] Behavioral authorization, policy, idempotency and UI tests; Shopify schema validation.
- [ ] Update this PR and verify a controlled sandbox install after release.

## Authorization and execution contract

The model must never choose the authenticated customer. Shopify's signed app proxy identifies the customer; a server-only record binds the admitted message to the browser identity version. Runtime actions resolve that record through their durable channel job and turn. Logout, account switching, connection revocation, a different store, and missing authentication fail closed. Public message metadata is not an authorization source.

Guest order proofs grant access to one matching order, not a customer account. Responses omit unrelated personal data. Mutations validate ownership immediately before dispatch, enforce merchant settings on the server, and use the existing durable tool ledger. An ambiguous external write is never automatically replayed. Approval resumes use the pinned original action and input, not a visitor-supplied approval flag.

Cart operations execute against the current storefront session using a bounded, origin-checked bridge. The existing runtime stores the approved, immutable command and a one-shot continuation; the shopper clicks Show cart or Update cart on the storefront. Locale-aware Shopify Ajax endpoints read the cart, add variants and set/remove existing lines. Only a sanitized display snapshot returns to Datool: cart tokens, notes, attributes and line properties stay in the store.

Cart writes require browser storage and Web Locks. A receipt is saved before dispatch and reused across clicks, reloads and tabs; a lost response or Shopify inventory error never causes an automatic replay. Each command expires after one hour, allowing old receipts to be removed. Unsupported browsers can use the store's cart directly. A `datool:cart:updated` DOM event provides the refreshed snapshot for themes that want to update their cart badge or drawer; themes must subscribe to it. These receipts prevent accidental replay, not deliberate same-origin storage tampering by a shopper.

Product cards use live catalog results, including product type/vendor/price filters, stock availability and product-page cursors. The merchant's stock exclusion setting cannot be weakened by model arguments. A card can offer cart selection only when exactly one enabled, non-private Update shopping cart action is available for the same store and channel. Its saved, expiring selection permits only the variants actually shown; selecting it runs the existing cart action and merchant approval path. It does not itself claim the cart was changed. Card selection, approval and browser cart completion reuse the existing tool records, without another queue or persistence table.

Large variant collections offer Show more options in chat. Each click reads the next
matching page of the same product with the original filters, using a saved one-hour
continuation. Browser arguments cannot replace the product, cursor or filters.
Each page rechecks publication and current merchant stock policy; empty filtered
variant pages are skipped. The returned page gets its own cart selection and retains
the cart action's approval policy. Browsing also works without a cart action.
Earlier pages remain in the conversation. Previously saved product actions use the
current native input schema without needing to be recreated. Catalog image search
and messaging-channel cart support remain unfinished. Prices use the store's base
currency and are re-evaluated by Shopify when the cart changes.

Shopify calculates prices, discounts, shipping, taxes and payment status. Browser cart totals are untrusted display data and must never authorize refunds, order prices or payment. The cart's Checkout link navigates to Shopify checkout; it does not create or prove a completed/paid order. Updating an account address does not change a placed order's delivery address.

Create order obtains its payment method, item source, phone requirement, tags and note from merchant settings. The native adapter only sends live variant IDs and quantities to Shopify's draft-order calculation; it does not accept model-supplied prices. Physical goods require an address and an available Shopify shipping rate. The confirmation shows the Shopify subtotal, shipping, tax, total and payment behavior. A changed or expired quote requires a new confirmation or teammate approval before any order write.

Online payment returns Shopify's invoice checkout URL without completing or marking the order paid. Cash on delivery uses Shopify receipt payment terms and verifies the completed order remains unpaid. Free orders apply the merchant-authorized discount and free delivery, then require Shopify's total to be zero. A draft whose creation response differs from the confirmed totals is retained for review without completion.

Approved order intent, settings, operation tags and available draft/order IDs survive failed tool responses in a dedicated commerce table. Metering remains separate. An interrupted or uncertain attempt blocks a new order in the same conversation. Check checkout reads the saved draft/order ID, or searches the exact operation tag when the create response was lost. Missing search results never authorize a new order. An unambiguous online draft with matching buyer and totals recovers its existing unpaid checkout link. A completed draft recovers the placed order and current payment status; refunded or pending orders are not reported as paid. Logged-in customers can check their conversation on another verified device; guest access remains bound to the original browser session. Arbitrary external draft/order/customer IDs are not tool arguments.

Recovery performs no Shopify writes. An uncompleted cash-on-delivery/free draft, mismatched buyer/totals, or duplicate operation tag stays blocked for store-team review. A later check can recognize the original order after the store team completes it in Shopify. Supported in-chat resolution of incomplete or missing drafts and production webhook registration remain release requirements. Automatic payment checks reuse the worker as described below. A stale read cannot overwrite a newer recorded outcome.

Cart-based drafts currently support ordinary variant lines. The storefront bridge flags subscriptions, line properties and bundle relationships without sending their private contents to Datool. Those carts, and carts from an older bridge that cannot establish this flag, use the store checkout to preserve their options. The payment worker now authorizes cleanup of the original cart after verified placement, as described below. Messaging-channel payment notifications remain unfinished; issuing a checkout link alone cannot prove payment.

Existing abuse protections remain burst-oriented. This work does not add default daily message quotas or spending caps.

## Release gates

Public apps require Shopify approval for protected customer/order data. Access to orders older than 60 days additionally requires `read_all_orders` approval. Added permissions require merchant consent. Development-store validation, merged code, production deployment, permission grants and end-to-end verification are separate checks.

Order creation additionally requests `write_draft_orders` and `read_payment_terms`, alongside product and order reads. Existing installations must reconnect and consent; a local scope declaration does not grant access. The installation instructions list the complete configured scopes.

Apply migration 0065 after 0064 for durable order operations. Check checkout requires draft-order, order and customer reads (the corresponding granted write scopes include read access). Public protected customer data approval is still required.

## Verification recorded so far

The first implementation slice has six behavioral tests covering message-bound identity, account changes, tag policies, guest order proofs, account activation and one-shot customer confirmation. The confirmation regression fails on the prior runtime because it dispatches the change before consent. Seven Chromium story tests cover the confirmation and integration controls. Order/customer GraphQL operations validate against Shopify 2026-10. These are local checks; production still needs the new release and customer/order permissions.

The cart slice adds real-runtime database tests for both model calls and multi-step procedures: merchant approval precedes the browser command, replacement input is ignored, one usage record is produced on completion, and a consumed continuation cannot be reused. The host-script test covers origin/source checks, localization, private-field removal, duplicate/reload protection and ambiguous writes. Eighteen focused Shopify/bridge tests and ten Chromium chat stories pass locally. Cart populated, empty, keyboard-focus and error states were inspected at mobile and desktop widths; the draft message survives cart interactions.

Those full-path tests exposed an incompatible JSON Schema dialect in the new native customer/order tools. Their published schemas now target Draft 7, matching Datool's runtime validator. Regression checks demonstrated failures before the schema, composer-draft, procedure-cart and next-turn model-context fixes, then passed after repair. The existing generic approval/continuation checks remain required. No new Shopify GraphQL operations were introduced by the cart slice, and live-store cart verification is still pending release.

Variant paging extends those runtime cases through the public conversation: the
next page returns a previously unseen option, ignores forged product/cursor input,
works with the pre-upgrade saved action schema, and preserves cart approval and
one-shot consumption. Eight cart/product runtime cases and six commerce adapter
cases pass. Nine Chromium stories pass, including keyboard paging and an unchanged
composer draft. Showing multiple pages exposed duplicate landmark labels; product
collections now use labelled groups inside the conversation instead. Phone and
desktop checks found no horizontal overflow. The updated product query validates
against Shopify Admin GraphQL 2026-10. Provider responses remain test fixtures.

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

Apply migrations 0066–0069 and obtain `write_returns` plus the invoice/order scopes
before enabling the action. Production payment webhook registration still needs verification.
Separate replacement orders and their credit
accounting are not implemented. Full after-sales parity remains incomplete.

## Return recovery

Check return reads the saved operation within the verified project, store,
conversation and customer. Guests remain bound to their original browser session.
A known return ID is read directly; a lost creation response is recovered by
paginating the original order's returns and requiring an exact operation marker
on every requested line. A partial marker, duplicate match, incomplete pagination
or missing result never proves failure and cannot authorize a second write.

Recovery rechecks current order ownership, exact line quantities and Shopify's
processed quantities. It confirms only the approved refund amount with successful
or pending transactions; failed, incomplete or conflicting transactions require
review. Unpaid exchanges recover Shopify's existing additional-payment URL only
for the approved outstanding amount. Zero outstanding alone does not establish a
completed payment. The check sends no invoice. With fulfillment permissions it can release the
original recorded exchange payment holds after verifying payment.

The recovered ID and financial outcome use the existing commerce ledger with a
revision check; a stale read cannot overwrite a newer reconciliation. The original
mutation and recovery paths share item matching and refund verification. There is
no new queue, persistence table or provider-write retry loop.

Local runtime tests cover lost create/process/invoice responses and failed ID/result
saves, guest access from another conversation, changed ownership, ambiguous search,
partial processing, pending/successful/failed refunds and payment-link recovery.
A database lifecycle check covers an active writer and a newer reconciliation.
These use stubbed Shopify responses; live permission grants and provider outcomes
remain unverified. The existing return action can continue a recovered return that
is known never to have started processing, after a fresh quote and approval.
Check return can release recorded exchange payment holds after verified payment,
as described below; its recovery of refunds and invoices still performs no such writes.

The queries validate against Shopify Admin GraphQL 2026-10. Provider contracts:
[return transactions and state](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/Return),
[processed return quantities and reason notes](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ReturnLineItem),
and [existing additional-payment URL](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/OrderPaymentCollectionDetails).

## Reviewed return continuation

The same Return or exchange items action accepts either the original item selection
or only a Datool `operationId`. Continuation loads the saved original selection;
it cannot switch the order, shopper or items. It verifies the existing open return
and unprocessed quantities, rechecks live replacement stock, and obtains the
current suggested financial outcome. A changed or expired quote needs approval
again. Old pre-creation item-credit totals are omitted from the new quote rather
than being presented as current financial calculations.

The commerce ledger records a one-way processing marker before dispatch. A
revision-checked claim saves the newly approved quote and admits only one processing
attempt. A lost processing response cannot be replayed even if Shopify temporarily
reports zero processed quantities. Migration 0067 treats legacy records without
that history as unknown; only new admissions establish never-started status.
Creation failures and changed balances before processing can therefore continue
on the same return, while uncertain financial writes stay in reconciliation.

The original merchant approval requirement cannot be weakened by newer action
settings; changing the return-window policy also requests teammate review. An
already accepted return does not consume returnable quantities twice or become
ineligible solely because its original window elapsed while processing was delayed.
The current exchange policy and replacement-stock check still apply. This reuses
the action's existing confirmation/approval continuation, shared financial read,
and the same final processing path; it introduces no second workflow system.

Runtime cases cover continuation after lost creation, changed balance with a
preserved human-approval requirement, fresh price consent, unavailable stock,
forged confirmation fields, guest conversation isolation, one-shot processing and
unknown legacy history. Provider responses are stubbed; live-store verification
remains a separate release gate.

## Exchange payment holds

Before the invoice is sent, Datool records the exact payment-hold IDs on the
exchange's new fulfillment lines in the existing commerce ledger (migration 0068).
It reads all accessible fulfillment pages, maps the return's exchange order-line
IDs and quantities, and rejects mixed, incomplete or changed membership. Only
`AWAITING_PAYMENT` holds from Shopify or this app are eligible; another app's
holds are preserved. An unpaid Check return can finish recording after an
interrupted response or delayed routing. A paid exchange with no earlier plan
requires store-team review rather than adopting whatever holds exist later.

When Check return sees zero outstanding, `fullyPaid` and financial status `PAID`,
it rechecks ownership, the original processed items, refund activity and payment
before releasing each recorded hold. `AUTHORIZED` is insufficient. Every mutation
supplies explicit `holdIds`; omitting them would release unrelated holds. New
manual holds, fraud/inventory holds and other apps' holds remain untouched. A lost
release response is reconciled by reading the same immutable IDs. The code never
fulfills, restocks or marks replacements shipped, and does not repeat the return,
refund or invoice.

This reuses the existing commerce record and action, with no new queue or workflow.
Required grants are `write_merchant_managed_fulfillment_orders`, plus
`write_third_party_fulfillment_orders` for third-party locations, and the Shopify
user's `fulfill_and_ship_orders` permission. Incomplete visibility cannot authorize
a release. Existing catalog/payment reads remain usable without these grants.
Automatic payment checks and storefront notifications use the existing worker, as described below. Production subscription registration remains unverified.

The focused runtime cases cover explicit hold IDs, paginated membership, missing
or mixed fulfillment, pending authorization, changed ownership/balance/holds,
new holds after payment, lost release responses and failed hold-plan persistence.
Responses are stubbed. Shopify schema validation does not establish real permission
grants or fulfillment outcomes; live sandbox verification remains required.

Provider contracts: [managing exchanges](https://shopify.dev/docs/apps/build/orders-fulfillment/returns-apps/manage-exchanges),
[hold release and explicit IDs](https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/fulfillmentOrderReleaseHold),
and [exchange order-line membership](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ExchangeLineItem).

## Design review

The implementation deliberately reuses the Shopify SDK, Datool's action runtime, durable tool records, existing continuation storage and Inbox approvals. Customer confirmation and teammate approval now share one persistence path while retaining separate authorization rules. The mutation helper owns common Shopify error handling; callers describe only their action-specific response. The simplification is covered by four commerce tests and seven runtime tests for confirmation, approval, continuation and handoff behavior.

Order recovery uses one commerce record per approved intent because a terminal tool result clears its continuation, while usage events deliberately exclude order arguments and customer addresses. Admission locks only the database transaction, never a network request. The creation and recovery paths share money normalization and draft totals rather than implementing different comparison rules.

Keep the server-owned message identity record and the ownership recheck immediately before writes. Removing those checks would let untrusted chat input or stale account identity influence customer access. Keep ambiguous writes distinguishable from failures; a shorter automatic retry path could repeat a change that Shopify already applied.

For the remaining actions, Shopify remains responsible for prices, discounts, shipping, tax and payment state. Use the existing continuation mechanism for storefront interactions instead of introducing another queue or workflow engine. Order and return processing consume the same merchant settings and confirmation infrastructure. Return and order intent share the commerce ledger rather than separate queues or persistence systems.

Complete privacy/uninstall handling and scope/reconnect guidance, then verify the full customer journey in the sandbox, including delayed approvals and reconciliation after ambiguous writes. Passing the current unit and database tests does not replace those release checks.

## Delayed approval and session verification

When a teammate approves after the five-minute verification window, the runtime
keeps the original reviewed input and quote in a one-shot customer continuation.
It makes no Shopify request or financial write until the shopper selects
**Continue approved change** in the storefront. The existing browser bridge
refreshes the signed app-proxy identity before submitting that interaction.

The runtime compares the newly admitted message with the original browser,
customer, store, conversation and identity version. A different browser cannot
use that saved approval, even for the same customer. Logout, account switching
and disconnected integrations remain terminal authorization failures; they do
not become verification prompts. Approval is read only from the claimed server
record, and visitor input cannot replace its items or amount. Changed or expired
quotes still require fresh teammate approval. Normal action execution and its
immediate pre-write ownership checks remain unchanged.

This reuses the current continuation ledger, signed identity lookup and chat
confirmation card. It adds no endpoint, worker or table. Runtime/database tests
exercise the stale-session regression, guest and signed-in refresh, changed
prices, public chat delivery, pinned inputs, one-shot use, a different browser
and revoked account/integration bindings. Chromium coverage verifies the session
refresh before submission, keyboard activation, the visible reviewed input,
retained composer draft and disabled completed action. Provider responses remain
fixtures; live-store verification is still required.

Provider contract: [authenticated app proxies and signed customer identity](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies).

## Automatic commerce reconciliation

Migration 0069 adds a due time to the existing commerce ledger and a metadata-only
webhook receipt table. The existing channel job queue, leases, retries and
outbound delivery path handle reconciliation; no second financial execution
workflow is introduced. Webhook delivery and scheduled five-minute fallback
checks converge on the same checkout/return readers used by the shopper.
Existing unpaid cash-on-delivery orders enter the backfill, while historical
paid orders are left idle to avoid generating old payment notifications.

The receiver verifies raw-body HMAC through Shopify's SDK before tenant lookup,
bounds the body and saves no webhook PII. Receipt insertion and waking the
original operation are atomic. Events cannot choose an authenticated customer,
change approved amounts or initiate new orders/refunds/invoices. Shopify's live
buyer, item and payment checks remain authoritative. Existing exchange holds can
be released under their original recorded approval, even after browser expiry.
The original conversation retains its visitor authorization boundary.

Per-operation admission coalesces concurrent checks. Customer message jobs have
priority. A new event received while a check is running remains due; missed
webhooks are recovered by polling while a payment is unresolved. Notifications
use stable operation/milestone keys and atomically persist both the visible chat
message and model history. A lost hold-release response is reconciled by reading
the same hold IDs. It cannot repeat an invoice, refund or return.

Runtime and database tests exercise signed ingress, duplicate deliveries, a
forged payment status, revoked access, expired browser records, lost release
responses, failed message persistence and an event arriving during a read.
The order migration regression failed before unpaid cash-on-delivery records
were included; it now passes alongside the historical paid-order case.
Provider responses are fixtures, so live payment outcomes remain unverified.

Required production work includes registering the documented webhook topics,
releasing web/buildworker with migration 0069, obtaining the store's grants and
verifying a sandbox checkout, payment, duplicate delivery and exchange outcome.
Privacy/uninstall handling and messaging-channel notifications
remain separate unfinished requirements.

## Purchased cart cleanup

The storefront stores an expiring purchase snapshot locally when it shares an
ordinary cart for an order quote. Only its random reference and expiry cross the
bridge; the cart token is hashed locally and never leaves the store. The reference
survives price changes and fresh approval in the existing quote and commerce
ledger. It is not a model argument. Item-based orders never capture or clean a cart.

The existing payment worker sends a cleanup directive only after it verifies the
original placed order. Online orders require confirmed payment; cash-on-delivery
orders can clean up while payment is pending, and free orders after placement.
The order's current variant quantities must match the approved cart; merchant
edits, deleted variants and incomplete item reads leave the cart alone. Payment
and cleanup have separate delivery keys, so a later corrected order can permit
cleanup without repeating the payment message.
The chat reverifies the storefront identity before sending the directive to the
host. Only outbound, delivered controls can trigger cleanup; inbound metadata is
ignored. No extra model call, public endpoint or persistence table is introduced.

The host checks the original snapshot, visitor and cart token, then subtracts the
purchased quantities from matching line keys. Extra quantities observed at cleanup
and unrelated lines remain. Changed line keys are preserved, and a different cart
or device is left alone. One cart lock serializes Datool writes across tabs. A
pre-dispatch receipt and consumed snapshot prevent replay after duplicate events,
reloads or lost replies. An uncertain write produces a dismissible warning rather
than another mutation. Successful changes emit `datool:cart:updated`.

Snapshots and receipts expire after 30 days. Cleared storage, old widget versions
and unsupported browser primitives require manual cart management. Shopify Ajax
has no compare-and-swap operation: another theme/app changing the same quantities
between the final read and update is outside Datool's browser lock. The cleanup
uses one batch update by line key; it never calls cart clear or changes notes,
attributes, options or other lines. See the [Ajax Cart API](https://shopify.dev/docs/api/ajax/reference/cart).

The existing six order runtime cases cover all payment modes and item/cart sources,
including changed quotes, human approval, forged snapshot input, unpaid checkout,
edited order quantities/variants, incomplete provider reads, a later correction
and delivery through the public conversation. The browser bridge test covers
extra items/quantities, cross-tab deduplication, lost replies, snapshot reuse and a
different cart/device. Two chat stories cover automatic dispatch after identity
verification, ignored inbound metadata, polling deduplication, retained drafts and
the warning/dismiss path. These remain local checks, not live store proof.

The warning remains visible during automated accessibility checks. That check
exposed dashboard dark colors leaking into the light chat; the chat's central
warning tokens now follow its own theme. Mobile/desktop visual checks cover both
themes, keyboard focus and dismissing the warning without losing the draft.
