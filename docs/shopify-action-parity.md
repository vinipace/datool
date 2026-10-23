# Shopify customer journey actions

Implementation checklist for PR #36. The reference is [Chatbase's native Shopify actions](https://www.chatbase.co/docs/user-guides/chatbot/actions/shopify-actions), checked 23 October 2026. A checked implementation item is not evidence that a production store has granted its permissions.

## Delivery checklist

- [x] Bind customer authorization to authenticated channel messages and recheck identity before each action.
- [ ] Product discovery, variant IDs, stock filtering and product cards with cart controls.
- [x] Read and update the shopper's storefront cart; retain chat state during navigation.
- [ ] Online checkout, cash on delivery and free orders, with merchant-selected payment policies.
- [x] Own order history, status and tracking; guest lookup by order number and checkout email or phone.
- [x] Merchant-allowlisted order tags.
- [x] Account activation and sign-in guidance appropriate to the store's account system.
- [x] Update the authenticated customer's profile and default account address.
- [ ] Returns/refunds and exchanges on the existing order within merchant policy.
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

Shopify calculates prices, discounts, shipping, taxes and payment status. Browser cart totals are untrusted display data and must never authorize refunds, order prices or payment. The cart's Checkout link navigates to Shopify checkout; it does not create or prove a completed/paid order. Updating an account address does not change a placed order's delivery address.

Existing abuse protections remain burst-oriented. This work does not add default daily message quotas or spending caps.

## Release gates

Public apps require Shopify approval for protected customer/order data. Access to orders older than 60 days additionally requires `read_all_orders` approval. Added permissions require merchant consent. Development-store validation, merged code, production deployment, permission grants and end-to-end verification are separate checks.

## Verification recorded so far

The first implementation slice has six behavioral tests covering message-bound identity, account changes, tag policies, guest order proofs, account activation and one-shot customer confirmation. The confirmation regression fails on the prior runtime because it dispatches the change before consent. Seven Chromium story tests cover the confirmation and integration controls. Order/customer GraphQL operations validate against Shopify 2026-10. These are local checks; production still needs the new release and customer/order permissions.

The cart slice adds real-runtime database tests for both model calls and multi-step procedures: merchant approval precedes the browser command, replacement input is ignored, one usage record is produced on completion, and a consumed continuation cannot be reused. The host-script test covers origin/source checks, localization, private-field removal, duplicate/reload protection and ambiguous writes. Eighteen focused Shopify/bridge tests and ten Chromium chat stories pass locally. Cart populated, empty, keyboard-focus and error states were inspected at mobile and desktop widths; the draft message survives cart interactions.

Those full-path tests exposed an incompatible JSON Schema dialect in the new native customer/order tools. Their published schemas now target Draft 7, matching Datool's runtime validator. Regression checks demonstrated failures before the schema, composer-draft, procedure-cart and next-turn model-context fixes, then passed after repair. The existing generic approval/continuation checks remain required. No new Shopify GraphQL operations were introduced by the cart slice, and live-store cart verification is still pending release.

## Design review

The implementation deliberately reuses the Shopify SDK, Datool's action runtime, durable tool records, existing continuation storage and Inbox approvals. Customer confirmation and teammate approval now share one persistence path while retaining separate authorization rules. The mutation helper owns common Shopify error handling; callers describe only their action-specific response. The simplification is covered by four commerce tests and seven runtime tests for confirmation, approval, continuation and handoff behavior.

Keep the server-owned message identity record and the ownership recheck immediately before writes. Removing those checks would let untrusted chat input or stale account identity influence customer access. Keep ambiguous writes distinguishable from failures; a shorter automatic retry path could repeat a change that Shopify already applied.

For the remaining actions, Shopify remains responsible for prices, discounts, shipping, tax and payment state. Use the existing continuation mechanism for storefront interactions instead of introducing another queue or workflow engine. Checkout and return settings in the draft contract are reserved for unfinished actions; they do not establish implemented payment or return policy enforcement.

Before financial actions are considered ready, validate delayed approvals across the five-minute identity freshness boundary, provide an explicit re-verification path, and test reconciliation after ambiguous external writes. Complete privacy/uninstall handling and scope/reconnect guidance, then verify the full customer journey in the sandbox. Passing the current unit and database tests does not replace those release checks.
