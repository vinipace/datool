# Native Shopify integration

In **Agent → Integrations → Shopify**, choose **Connect store**, then
**Continue to Shopify**. Shopify lets you select a store and approve access.
Return to Datool to connect it to the project where you started. You do not
need to paste store domains or API keys.

Merchants starting from the Shopify App Store authorize Shopify first, then
sign in to Datool and choose an organization and project. Reopening an existing
store reuses its connection and project. In **Actions → Create action → Connected
app**, add **Search products** and **Read store policies** to the agent.

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

Product results use the same shape as the pilot's product-card widget. Keep
the `show_products` widget action enabled to display cards. Storefront chat
installation is separate from the data connection. This connector does not
install a theme embed. Cart, checkout and return/exchange work is tracked in
[the action parity checklist](shopify-action-parity.md).

Customer-specific actions require a freshly verified Shopify storefront chat.
Customer IDs in messages, tool arguments, contact fields or browser metadata
never authorize access. Newly added customer/order actions require merchant
consent and Shopify protected customer data approval before a public launch.
Existing catalog-only installs can continue using product and policy reads.

Execution runs directly from the Datool worker to Shopify's Admin GraphQL API
2026-10; it does not call the Shopify development app or its temporary tunnel.
Native calls record integration usage with no configured Composio charge.
Normal agent model usage still applies.

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

1. Apply migrations through `0064_shopify_commerce_identity.sql` using the normal release
   flow. Existing organizations retain Stripe ownership.
2. Configure a public standalone Shopify app with application URL
   `https://YOUR_DATOOL_HOST/api/shopify/install`, redirect URI
   `https://YOUR_DATOOL_HOST/api/shopify/callback`, and
   `read_products,read_legal_policies,write_app_proxy,write_customers,write_orders`.
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
