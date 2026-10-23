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
  Results include images, product URLs, base-currency prices and up to five
  variants. Draft, unpublished and future-published products are excluded.
- `SHOPIFY_READ_POLICIES`: published legal, shipping and return policies.
  Missing policies remain missing; truncated bodies are explicitly labelled.

Product results use the same shape as the pilot's product-card widget. Keep
the `show_products` widget action enabled to display cards. Storefront chat
installation is separate from the data connection. This connector does not
install a theme embed, modify carts, read orders/customers or issue refunds.

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

1. Apply migrations through `0062_shopify_billing.sql` using the normal release
   flow. Existing organizations retain Stripe ownership.
2. Configure a public standalone Shopify app with application URL
   `https://YOUR_DATOOL_HOST/api/shopify/install`, redirect URI
   `https://YOUR_DATOOL_HOST/api/shopify/callback`, and
   `read_products,read_legal_policies`. The official Shopify SDK performs the
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

Public launch also requires the listing/review process, privacy and uninstall
webhooks, and a production storefront extension. This integration alone does
not publish the app or install its chat widget. The local React Router pilot
remains a separate app until its extension is moved to the production app.

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

The native tool allowlist contains only the two reads above. Visitor arguments
cannot choose a different store or supply arbitrary GraphQL. Existing agent
approval and channel restrictions still apply to connected-app actions.

References: [standalone app authentication](https://shopify.dev/docs/apps/build/authentication-authorization/authenticate-standalone-apps),
[expiring offline tokens](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens),
and [policy scope](https://shopify.dev/docs/api/admin-graphql/2026-10/objects/ShopPolicy).

Billing references: [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing)
and [subscription verification](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/redirect-plan-selection-page).
