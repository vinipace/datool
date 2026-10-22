# Native Shopify integration

In **Agent → Integrations → Shopify**, enter the store's `myshopify.com`
address, choose **Connect store**, and open **Authorize account**. Approve
read access in Shopify, return to Datool and choose **Check connection**.
In **Actions → Create action → Connected app**, select that store and add
**Search products** and **Read store policies**. The agent editor applies the
saved actions to live conversations.

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

## Installation setup

1. Apply `0061_build_shopify_connections.sql` through the normal migration flow.
2. Configure a Shopify app for the standalone/API-only authorization-code flow.
   Register the exact redirect URI `https://YOUR_DATOOL_HOST/api/shopify/callback`.
   Configure `read_products,read_legal_policies` and the appropriate distribution
   for your pilot stores. Public merchant distribution still requires Shopify's
   applicable app review. Do not change an existing embedded app's installation
   flow merely to enable this connector.
3. Set `DATOOL_SHOPIFY_CLIENT_ID` and `DATOOL_SHOPIFY_CLIENT_SECRET` on **both web
   and buildworker**. Set `BETTER_AUTH_URL` to the canonical HTTPS Datool origin.
   Use the existing `DATOOL_PROVIDER_ENCRYPTION_KEY` (or `BETTER_AUTH_SECRET`)
   credential-encryption configuration; preserve it across releases.
4. Complete a real store authorization and check product/policy actions before
   reporting the connector as live. Local mocked OAuth tests do not establish
   Shopify distribution, callback registration or merchant consent.

The card explains that setup is required when the OAuth client is not configured.
The existing single-store React Router pilot remains a separate local app.

## Authorization and failure behavior

Only a project member with `build:write` can create a connection intent. Its
random start token is stored as a hash, expires after ten minutes and is consumed
once. The official Shopify library verifies the signed OAuth browser cookie,
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
