# Native Shopify integration

In **Agent → Integrations → Shopify**, choose **Connect store**, then
**Continue to Shopify**. Shopify lets you select a store and approve access.
Return to Datool to connect it to the project where you started. You do not
need to paste store domains or API keys.

Merchants starting from the Shopify App Store authorize Shopify first, then
sign in to Datool and choose an organization and project. Reopening an existing
store reuses its connection and project. In **Actions → Create action → Connected
app**, add the product, customer or order actions that the agent needs.

Connections belong to the current project and can be used by its agents.
Reconnecting a store in the same project preserves the connection ID so existing
actions keep working. A store/app pair cannot be connected to two projects:
Shopify maintains one current expiring offline token pair for each app/store.
Disconnect removes Datool's credentials and blocks all actions using that
connection. It does not uninstall the Shopify app or affect unrelated Datool
connections.

## Capabilities

- `SHOPIFY_SEARCH_PRODUCTS`: an empty query browses up to eight published,
  active products. Non-empty queries search titles using escaped terms.
  Results include product/variant IDs, images, URLs, base-currency prices and up to twenty
  variants. Draft, unpublished and future-published products are excluded.
- `SHOPIFY_READ_POLICIES`: published legal, shipping and return policies.
  Missing policies remain missing; truncated bodies are explicitly labelled.
- `SHOPIFY_GET_ORDERS`: verified customer order history, status and tracking.
  Guests can look up one order using its number and exact checkout email or phone.
- `SHOPIFY_UPDATE_PROFILE` and `SHOPIFY_UPDATE_ADDRESS`: change the verified
  customer's own account after one-shot confirmation. An account address update
  does not change delivery addresses on placed orders.
- `SHOPIFY_ACTIVATE_ACCOUNT`: legacy account invitations, with a ten-minute
  per-recipient cooldown, or sign-in guidance for new customer accounts.
- `SHOPIFY_TAG_ORDER`: merchant-allowlisted tags on the verified customer's own order.
- `SHOPIFY_GET_CART` and `SHOPIFY_UPDATE_CART`: read and update the shopper's
  current storefront cart through the theme bridge, with merchant approval and
  one-shot browser controls.
- `SHOPIFY_CREATE_ORDER`: calculate a quote for selected items or ordinary cart
  lines, then require confirmation or teammate approval. Merchant settings select
  online payment, cash on delivery or a free order. Online payment returns an
  unpaid Shopify checkout link; other modes validate the total and payment terms
  before completing the draft. Uncertain writes require reconciliation.
- `SHOPIFY_CHECK_CHECKOUT`: recover the existing checkout or order and read its
  current payment status. Enable **Check checkout** alongside **Create order**.
  It accepts an operation ID returned by Datool, or checks the latest attempt in
  the verified shopper's conversation. It never creates an order or takes payment.
  Missing results remain unresolved; duplicate matches and changes to the buyer
  or approved total require store-team review.

- `SHOPIFY_GET_RETURN_OPTIONS`: read remaining returnable quantities for an owned
  order. Guests supply the order number and its checkout email or phone.
- `SHOPIFY_RETURN_OR_EXCHANGE`: quote and confirm a return/refund or permitted
  exchange on the original order. Merchant settings control the delivery-based
  return window (30 days by default, empty for no limit), exchanges and teammate
  approval. Shopify supplies amounts and original payment transactions. Pending
  refunds remain pending; payable exchanges receive a Shopify invoice and remain
  on fulfillment hold. The action never claims physical receipt or restocks goods.
  To continue an existing return that stopped before processing, supply only
  `{ "operationId": "DATOOL_OPERATION_UUID" }`. Datool keeps the original items,
  obtains the current Shopify balance, and requests fresh confirmation or teammate
  approval. It rechecks replacement stock and preserves the original approval
  requirement even if the action settings were later relaxed. An attempted refund
  or exchange is never replayed.
- `SHOPIFY_CHECK_RETURN`: recover the original return after a lost response or
  database-save failure and check refund/payment status. Enable **Check return**
  alongside **Return or exchange items**. It accepts Datool's operation ID, or
  checks the latest return in the verified shopper's conversation. Recovery uses
  the stored return ID or searches the original order for an exact operation
  marker. It never creates a return, repeats a refund or resends an invoice.
  Pending refunds stay pending. An unpaid exchange can recover its existing
  Shopify payment link only when the outstanding balance matches the approved
  amount. Paid status requires Shopify's paid flag and zero outstanding balance;
  with fulfillment permissions, this check releases only the exchange payment
  holds recorded before payment. Other holds remain. This never marks an item
  shipped. Missing/ambiguous matches, changed ownership or unmatched processed
  amounts require review.
  Unprocessed returns can use the existing return action's continuation flow.

Product searches render native product cards. An enabled **Update shopping cart**
action for the same connection adds variant and quantity controls. Storefront chat
installation is separate from the data connection. This connector does not
install a theme embed. Payment updates and purchased-cart cleanup use the existing
channel worker. Resolution of incomplete drafts and returns, and replacement-order work remain tracked in
[the action parity checklist](shopify-action-parity.md).

Customer-specific actions require a freshly verified Shopify storefront chat.
Customer IDs in messages, tool arguments, contact fields or browser metadata
never authorize access. Newly added customer/order actions require merchant
consent and Shopify protected customer data approval before a public launch.
Existing catalog-only installs can continue using product and policy reads.

Catalog, customer and order execution runs directly from the Datool worker to
Shopify's Admin GraphQL API 2026-10. Cart actions use the shopper's storefront
session. Neither path calls the Shopify development app or its temporary tunnel.
Native calls record integration usage with no configured Composio charge.
Normal agent model usage still applies.

Apply migrations through 0069 before enabling these actions. Confirmed order
intent is stored separately from usage events so interrupted tool responses do
not erase the information needed for recovery. Checkout reads require draft-order,
order and customer access; the corresponding write scopes also grant read access.
Returns require `write_returns`, order/customer/product reads, and `write_orders`
for exchange invoices. Automatic payment-hold release also needs
`write_merchant_managed_fulfillment_orders` and, for external fulfillment locations,
`write_third_party_fulfillment_orders`. The Shopify user must be allowed to fulfill
and ship orders. Existing installations must reconnect to grant new scopes.
Without those grants, return/payment reads remain usable and identify the missing
permission; they never claim a hold was released.
Return admission uses the same commerce ledger, keyed to the original order
across conversations. A timeout or database failure after dispatch keeps the
operation unresolved and prevents another return attempt until reviewed.
Migration 0067 records whether processing has ever started. Existing records without
that history are conservatively treated as unknown, so they can be reconciled but
not replayed. Only a recorded never-started operation may continue in chat.
Migration 0068 stores the exact exchange payment-hold IDs and fulfillment lines
observed before payment. A paid exchange with no saved hold plan requires review.
A lost hold-release response is recovered by reading those same IDs; no refund,
invoice, newly added hold or shipment is repeated. Payment reconciliation also runs
in the background, using the same checks as Check return. The worker only releases
previously recorded exchange payment holds;
it cannot create an order, refund or invoice.

## Billing ownership

- Starting in Datool keeps that organization's current billing provider.
- Starting in Shopify uses Shopify App Pricing for a new organization. An
  existing organization with a Stripe customer, subscription or pending checkout
  keeps Stripe billing, preventing two payment relationships.
- Shopify organizations use Shopify's hosted plan selector for subscriptions,
  upgrades and cancellation. They cannot create Stripe checkout sessions.
- One Shopify store bills one organization. Stores already linked to a project
  cannot be moved to another project through a reconnect.

The server verifies the active contract through the Partner API (2026-10).
`plan_handle` and shop query parameters never grant access. A confirmed contract
is cached for at most five minutes; background reconciliation refreshes it.
Provider failures preserve stored state but cannot extend expired access.

Core and Pro use the same record and retention entitlements as the corresponding
Datool plans. A verified, positive-price USD monthly Shopify cycle grants the
included execution allowance once. Trials and no-charge developer plans do not
receive funded execution credits; use your own model credentials for those
plans. An upgrade does not issue a second allowance within the same cycle.

## Installation setup

1. Apply migrations through `0069_shopify_reconciliation.sql` using the normal release
   flow. Existing organizations retain Stripe ownership.
2. Configure a public standalone Shopify app with application URL
   `https://YOUR_DATOOL_HOST/api/shopify/install`, redirect URI
   `https://YOUR_DATOOL_HOST/api/shopify/callback`, and
   `read_products,read_legal_policies,write_app_proxy,write_customers,write_orders,write_draft_orders,read_payment_terms,write_returns,write_merchant_managed_fulfillment_orders,write_third_party_fulfillment_orders`.
   Customer and order access must be approved for the public app. The official Shopify SDK performs the
   authorization-code flow. Do not switch an existing embedded app's flow just
   to enable this connector.
3. Set the following server-only variables on web and buildworker:

   | Variable                                                            | Source                                                      |
   | ------------------------------------------------------------------- | ----------------------------------------------------------- |
   | `DATOOL_SHOPIFY_CLIENT_ID`, `DATOOL_SHOPIFY_CLIENT_SECRET`          | App credentials in Dev Dashboard                            |
   | `DATOOL_SHOPIFY_APP_HANDLE`                                         | App handle in app configuration                             |
   | `DATOOL_SHOPIFY_APP_ID`                                             | Numeric app ID in Partner Dashboard                         |
   | `DATOOL_SHOPIFY_PARTNER_ORGANIZATION_ID`                            | Numeric organization ID in Partner Dashboard                |
   | `DATOOL_SHOPIFY_PARTNER_ACCESS_TOKEN`                               | Partner API client with **Manage apps** permission          |
   | `DATOOL_SHOPIFY_CORE_PLAN_HANDLE`, `DATOOL_SHOPIFY_PRO_PLAN_HANDLE` | Recurring subscription item handles; defaults `core`, `pro` |

   Keep `BETTER_AUTH_URL` on the canonical HTTPS origin and preserve the existing
   credential encryption key across releases. Never put Partner API credentials
   into browser code or theme settings.

4. Complete App Store registration and configure **Shopify App Pricing** in the
   Partner Dashboard listing. Define monthly Core and Pro plans with the intended
   prices and matching recurring item handles. Set each plan's welcome URL to
   `https://YOUR_DATOOL_HOST/shopify/billing`. The return page authorizes the
   organization before independently verifying the subscription.
5. Keep the existing app URL until the matching code, credentials and plans are
   ready. Verify both acquisition paths on a development store: OAuth, account
   linking, plan approval, return, entitlement, cancellation, reconnect and live
   product/policy calls. Local mocked tests are not live merchant proof.

The card shows setup is required when OAuth credentials or the app handle are
missing. Partner subscription verification additionally needs the Partner API
settings above. OAuth credentials and the Partner API token are different.

Public launch still requires the listing/review process and privacy and uninstall
webhooks. The production theme extension is maintained in
`integrations/shopify/extensions/datool-chat`; it must be released on the same
Shopify app as the OAuth connection. A local pilot extension belongs to a
different app and does not inherit its credentials or configuration.

## Authorization and failure behavior

Only a project member with `build:write` can create a Datool-origin intent.
Its random start token is stored as a hash, expires after thirty minutes and is
consumed once. App Store launches require Shopify's signed, recent request.
The temporary OAuth receipt survives Datool sign-in but contains no credentials.
An organization owner or admin must claim the authorized store. The official Shopify library verifies the signed OAuth browser cookie,
state and Shopify HMAC. The callback checks the requested store, project-bound
intent, app client and granted scopes before activation. An expired, replayed or
disconnected intent cannot activate a connection.

Offline access and refresh tokens are encrypted with AES-GCM and bound to the
project and connection. Refresh is serialized under a database lock across
web/buildworker processes. Credentials are never returned in the connection
catalog, actions or traces. Shopify requests require an exact `myshopify.com`
hostname over HTTPS, disallow redirects and bound response size and duration.
Provider errors are sanitized; an expired/revoked authorization needs reconnection.

The native tool allowlist contains only the actions described above. Visitor arguments
cannot choose a different store or supply arbitrary GraphQL. Existing agent
approval and channel restrictions still apply to connected-app actions.

References: [standalone app authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
[expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens),
and [policy scope](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ShopPolicy).

Billing references: [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
and [subscription verification](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page).

## Storefront chat and customer identity

Release the server and migration before changing the Shopify extension. Copy
`integrations/shopify/extensions/datool-chat` into the production app's extension
directory. Configure one proxy in that app's TOML:

```toml
[app_proxy]
url = "https://YOUR_DATOOL_HOST/api/shopify/storefront"
prefix = "apps"
subpath = "datool"
```

Validate the configuration with `shopify app config validate --json`, then release
it through the normal Shopify workflow. Existing stores must reconnect to grant
`write_app_proxy`. In Datool **Integrations → Shopify**, choose the store's enabled
chat bubble and select **Connect chat bubble**, then open the theme editor, enable
**Datool chat** in App embeds, and save. The setup writes a public configuration
app-data metafield on the current AppInstallation and allows the verified store's
primary domain and myshopify.com origin. No secrets go into Liquid. App-data
metafields cannot have a TOML definition. The equivalent authenticated operation is
`build_configure_shopify_chat({ connectionId, channelId })`.

The default proxy path is `/apps/datool`. If the merchant customizes that path,
update the extension to match; a failed proxy must not fall back to unverified
customer identity. Test both a custom store domain and myshopify.com.

Guests retain a random browser identity for 30 days, refreshed when they return.
Storage is first-party on the storefront; clearing browser data or disabling
storage loses guest continuity. Shopify browsers store only an exchange
credential. Every exchange goes through Shopify's signed proxy and verifies its
HMAC, recent timestamp, installed store, channel binding and storefront origin.
Only the signed `logged_in_customer_id` selects a customer. Customer history is
shared across that customer's authenticated devices; guest history is kept
separate and is not automatically merged.

Customer access tokens last five minutes and carry a browser identity version.
A fresh proxy exchange on page load, focus, every minute while visible, and before
sending detects logout/account changes and revokes the browser's older tokens.
Hidden chat content is cleared until revalidation. This is not an instantaneous
Shopify logout webhook: a token can remain valid until the next exchange or its
expiry. Channel or Datool connection disablement also denies reads. Shopify
uninstalls must be processed by the uninstall webhook/reconciliation before local
connection state reflects revocation. No customer profile, email or order access
is added. The contact records the verified store/customer ID; include that data
in the installation's privacy export/deletion and retention workflow before
public launch.

## Abuse controls

Public web channels default to **20 message attempts per visitor per minute**.
Exceeding this burst limit returns HTTP 429 with Retry-After (at most 60 seconds)
before a model job is queued. The visitor can continue when the window resets;
starting a new conversation or changing IP does not bypass it. Rejected flooding
is checked before shared client-IP counters so it does not consume other shoppers'
allowance.

There is **no daily visitor quota by default** and no additional channel-wide
session/message ceiling. To tune burst protection, configure
`publicAdmission.visitorMessagesPerMinute` (1–120) with `build_update_channel`.
A merchant can explicitly opt into `publicAdmission.visitorMessagesPerDay`
(1–10000 per UTC day); omit it for new channels or set it to `null` to remove a
previously configured daily quota. Security rollout must not add daily message or
spend quotas to agents on the merchant's behalf.

Existing client admission limits remain configurable through
`publicAdmission.session`, `.message` and `.feedback`. Only configure a trusted
client-IP header when the edge proxy overwrites it and clients cannot reach the
origin directly. Without that trust, authenticated message/feedback requests use
the verified visitor as their client bucket; new anonymous sessions still share a
conservative bucket. Configure trusted edge admission for storefront traffic.
These controls do not replace infrastructure DDoS protection.

Set both `DATOOL_TURNSTILE_SITE_KEY` and `DATOOL_TURNSTILE_SECRET_KEY` on the web
service to enable Cloudflare Managed Turnstile for new visitors. The widget must
allow the canonical `BETTER_AUTH_URL` hostname because it runs inside Datool's
iframe. The public key is returned to the browser; the secret stays server-only.
The server verifies success, hostname, action and channel binding through
Siteverify. Existing valid visitor credentials resume without another challenge.
Both variables absent disables the challenge; partial configuration fails closed.
Provider failure or cancellation shows a retryable security check rather than
issuing a new visitor. Do not use Turnstile testing keys in production.

Keep input length, maximum output, spam checks and operational capacity controls
separate from merchant-selected usage quotas. Daily turns and daily model budgets
are optional cost controls, not requirements for abuse protection. Daily model budget
admission grows its reservation **before each model step**, including history,
knowledge and tool-result context. Concurrent reservations share a database lock;
unknown cost retains the reservation. Catalog-based text estimates are
conservative, not a provider invoice or a cap on separate retrieval, external-tool
or infrastructure charges. Keep provider-side billing limits as an independent
ceiling.

Validate on a development store before release: a fresh guest challenge, returning
guest after browser restart, logged-in customer across devices, logout/account
switch, forged or expired credentials, conversation resets at the message quota,
and budget exhaustion before another tool-driven model call. Enable the theme
embed only after the deployed proxy and channel binding work.

Identity reference: [authenticated app proxies](https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies).
Challenge reference: [Turnstile server validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

## Automatic payment updates

The web process accepts Shopify deliveries at
`https://YOUR_DATOOL_HOST/api/shopify/webhooks/commerce`. Configure the production
app's webhook subscriptions with API version **2026-10** for these topics:

- `orders/create`, `orders/paid`, `orders/updated`, `orders/cancelled`
- `draft_orders/update`
- `returns/process`, `returns/update`
- `fulfillment_orders/order_routing_complete`

Use the app configuration or Dev Dashboard, then release that Shopify app
configuration. Declaring an endpoint in Datool does not register subscriptions.
The return topic is `returns/process`, not `returns/processed`. See Shopify's
[topic reference](https://shopify.dev/docs/api/admin-graphql/2026-10/enums/WebhookSubscriptionTopic)
and [delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).
These subscriptions are separate from the mandatory privacy/uninstall handlers,
which remain a public-release requirement.

Apply migration 0069 and run the updated **web and buildworker** releases. The
receiver uses the official SDK to verify the signature over the original body,
deduplicates deliveries and marks existing operations due in one transaction.
It stores a hashed receipt rather than the order/customer payload. Database
admission failures return 503 so Shopify can retry. An unknown store, disabled
organization or unrecognized topic cannot create an operation.

The existing worker coalesces pending checks per operation and gives customer
messages priority. Pending payments are checked every five minutes as a fallback
for delayed or missed deliveries; a webhook wakes the check sooner. Each check
reads current Shopify state and the original buyer/items. Out-of-order webhook
bodies never become payment truth. An event arriving during a check stays due.
Completed payments/refunds produce one message per milestone in the original
conversation, atomically recorded with model history and the delivery job.
Retries cannot create duplicate notifications or replay financial mutations.

A browser session expiring does not cancel an already approved exchange. The
worker can reconcile that saved intent, while chat access still requires a valid
visitor credential. A new customer cannot read the original conversation.
Disconnecting the integration or changing the store's channel binding prevents
background processing. Missing grants or ambiguous provider state require store
review. A paid exchange without a pre-payment hold snapshot still requires
review; the worker never adopts new holds after payment.

The implementation and local tests do not prove a production subscription is
registered, Shopify has granted the scopes, or a real payment has been received.
Verify those separately in the sandbox before public release. Messaging-channel
notifications remain unfinished.

For cart-based orders, the updated widget stores the original cart snapshot in
first-party browser storage and shares only an opaque reference. Once the worker
verifies placement (and payment for online checkout), it sends a directive through
the existing public conversation. The chat verifies the store session again; the
host removes the purchased quantities from matching lines in the same cart.
New quantities and unrelated items observed at cleanup remain. Another device,
a changed cart token or changed line keys cannot cause removal from another cart.
Item-based orders leave the cart untouched.

Deploy the matching widget, chat and worker together. Cleanup requires the original
browser snapshot, storage and Web Locks; snapshots last 30 days. Ambiguous writes
are never repeated. The shopper sees a dismissible warning to check the cart if
completion cannot be confirmed. Other theme/app writes cannot share Datool's lock,
so concurrent same-line changes during the Ajax read/update window remain a limit.
No additional scopes or migration beyond 0069 are required for this cleanup.
