# Shopify resubmission

Use this checklist after a billing or interface change. A passing local test is
not proof that the deployed app or Partner Dashboard has been updated.

## Release and billing verification

1. Review and deploy the intended source revision. Confirm the production app
   uses the same Shopify client, app handle and hosted plan configuration as the
   listing. No new database migration is required for the billing-routing fix.
2. Audit existing `build_shopify_connections` joined through `project` to
   `organization_billing`. Any connected organization still using Stripe needs
   a merchant-approved resolution before it can use Shopify billing. The fix
   blocks further external checkout/portal access; it does not cancel an existing
   subscription, move a store, or migrate a payment relationship.
3. Start from the actual App Store listing in a fresh browser session. Cover a
   new user, an existing unpaid organization, an existing Stripe customer, an
   active subscription and an abandoned Stripe checkout. Existing payment
   relationships must require a separate Shopify organization.
4. Before and after linking the store, open `/pricing`, `/billing`, the homepage
   plan links, and organization creation/switching. Repeat after disconnect and
   reconnect. Shopify users must never reach external checkout or its portal.
5. Test Shopify plan acceptance and decline, upgrade/downgrade, cancellation and
   uninstall/reinstall on a development store. Check verified subscription state
   and entitlements. Do not approve a real charge solely to make a recording.
6. Confirm a user with no Shopify association can still purchase and manage an
   ordinary Datool subscription.

The regression owners are `tests/shopify-billing.test.ts`, `tests/billing.test.ts`
and `components/workspace/shopify-onboarding.stories.tsx`. The first two require a
disposable PostgreSQL database via `DATOOL_TEST_DATABASE_URL`. Run style checks,
lint and typecheck before pushing.

## Refresh review assets

- Capture the current deployed UI using a development store and sample data.
  Replace screenshots whose navigation, labels or layout have changed. Capture
  only the application viewport; exclude browser chrome and the desktop.
- Follow the current [listing asset requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/best-practices).
  Keep original captures and a manifest recording source revision, environment,
  dimensions and date. Store real screenshots and recordings under ignored
  `artifacts/`, outside the public repository.
- Record a new reviewer walkthrough: install and authorize, connect an eligible
  organization, open Shopify's plan selector, configure Shopify actions and the
  chat channel, enable the theme app embed, show product discovery and cart,
  verify order ownership, and demonstrate teammate handoff. Clearly distinguish
  fixture previews from a live development-store installation.
- Replace the listing's desktop screenshots and reviewer video link only after
  checking the final files. Confirm the reviewer can access the video and any
  test credentials through the submission's designated private fields.

## Submit

Recheck the current review status and all open reviewer findings. Supply a short
response describing the billing correction and the exact steps for verification.
Confirm preliminary checks, protected customer data status, privacy/support URLs,
pricing disclosure and refreshed assets. Submit the reviewed release through the
Partner Dashboard, then save the confirmation and submission revision privately.

References: [App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements),
[Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing),
[review submission](https://shopify.dev/docs/apps/launch/app-store-review/submit-app-for-review).
