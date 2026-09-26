# Datool Cloud billing

Cloud billing is opt-in. `DATOOL_BILLING_ENABLED=false` (the default) preserves
self-hosted access and does not require Stripe credentials. The branch adds
`/pricing`, organization billing at `/billing`, hosted Checkout, the customer
portal, signed webhooks, and server-side subscription enforcement.

## Cloud onboarding

Account and organization setup use the shared full-screen `OnboardingShell`:
logo and form on the left, the chosen plan’s benefits on the right. Sign-in,
sign-up, and organization setup share the same read-only plan summary with the
Stripe logo. The chosen plan carries through to checkout. There are no
numbered setup steps. Once the status endpoint confirms subscription access,
the checkout return automatically opens `/projects`. For an organization without
projects, that route shows an inline first-project form in the same two-column
layout, with the landing page workflow visualization on the right (hidden on
mobile). Project creation opens the new project's traces page.

Direct sign-ups without a plan use the same organization form, then `/pricing`
reuses the public pricing page, including the plan comparison and FAQs, with a
sign-out header and no default selection. Choosing a plan opens Stripe.
Until subscription access is confirmed, workspace and settings routes return to
plan selection; the setup screens offer sign-out without workspace navigation.
Reloading or signing back in resumes that gate. Organizations with an existing
subscription instead return to Billing for payment recovery. Self-hosted installs
with billing disabled keep their existing organization/workspace flow.

Pricing links retain the chosen plan in `/billing?plan=core` or
`/billing?plan=pro` through sign-in and organization selection. New organizations
use a focused setup form with the plan and monthly price visible; creating one
continues to Stripe Checkout. A failed payment-page request retries the created
organization instead of creating another. Existing organizations can be selected
before reviewing their billing status.

Checkout fills an empty Stripe customer email from the authenticated user's
session and preserves an existing billing contact. Success and cancellation URLs
retain the chosen plan. While Stripe confirmation is pending, billing polls for
verified subscription access and hides the subscribe form to avoid a second
payment attempt.

## Configure an installation

Set `DATOOL_CONTACT_EMAIL` to the public address for Custom plan inquiries.
The pricing page reads it at request time and uses it for both contact links.
Leave it empty to hide those links. Configure the address in the deployment
environment or an ignored local env file; do not hardcode it in source.

1. Apply migrations with `bun run db:migrate` (includes `0036_cloud_billing.sql`, `0037_cloud_entitlements.sql`, and `0039_billing_reconciliation.sql`).
2. Create two active, fixed monthly USD prices in the Datool Stripe account:
   Core at US$29 and Pro at US$199.
   Configure `STRIPE_CORE_PRICE_ID` and `STRIPE_PRO_PRICE_ID` with those IDs.
3. Set `STRIPE_SECRET_KEY` and create a webhook destination at
   `https://YOUR_HOST/api/billing/webhook`. Subscribe to
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `customer.subscription.paused`, `customer.subscription.resumed`,
   `invoice.paid`, and `invoice.payment_failed`.
   Set the destination's signing secret as `STRIPE_WEBHOOK_SECRET`.
4. Configure Stripe's customer portal for payment methods, invoices, plan
   changes between these prices, and cancellation at the end of the period.
   Set upgrades to invoice prorations immediately and schedule price decreases
   at period end (`schedule_at_period_end.conditions: decreasing_item_amount`).
   Set `STRIPE_PORTAL_CONFIGURATION_ID` to use a specific configuration;
   otherwise Stripe's default portal configuration is used.
5. Set `BETTER_AUTH_URL` to the canonical HTTPS origin. Checkout and portal
   return URLs use this value, never a caller-supplied host or return URL.
6. Set `DATOOL_BILLING_ENABLED=true` and restart the application. Enabling it
   requires **every organization** to subscribe; existing organizations are
   not automatically granted paid access. Keep billing off on existing
   self-hosted installations.
7. To allow public Cloud signup, configure Google OAuth and explicitly set
   `AUTH_ALLOW_PUBLIC_SIGNUP=true`. Google must still verify the email address.
   Without this flag, the existing `AUTH_ALLOWED_DOMAINS` policy is preserved.

Keep secret keys server-side. Neither API keys nor webhook secrets are exposed
in the browser or committed. Sandbox and live prices/configurations are separate;
replace all corresponding IDs and secrets together when activating live billing.
Stripe business verification/activation must be completed before charging real
customers. This implementation does not deploy or activate live payments.

## Plans and prices

Datool Cloud charges fixed monthly subscriptions in USD:

| Plan | Monthly USD price |
| ---- | ----------------: |
| Core |             US$29 |
| Pro  |            US$199 |

Checkout explicitly uses USD and disables Adaptive Pricing so customers are
charged these amounts without automatic local-currency conversion. The
pricing page reads the configured Stripe prices at request time and refuses to
advertise inactive, non-USD, metered, or non-monthly prices.

For installations previously configured with BRL prices, create new USD prices
and replace both environment price IDs together. Update the customer portal's
allowed prices as well. Existing subscriptions are not migrated automatically;
switching configured IDs changes which subscriptions grant access. Sandbox
and live configuration must each use their own matching USD prices.

Both plans include all product features, with different allowances:

| Plan | New trace/span records per calendar month | Trace retention |
| ---- | ----------------------------------------: | --------------: |
| Core |                                   100,000 |         90 days |
| Pro  |                                 1,000,000 |        365 days |

A new trace or span is one record. A trace containing five spans uses six
records. Updates, duplicate queue deliveries, and import conflicts do not count
again. Deleting data does not refund usage. Usage is shared across the
organization's projects and resets at 00:00 UTC on the first of each month,
independently of the subscription renewal date. Upgrades/downgrades change the
allowance without resetting accumulated usage.

Billing shows trace/span totals, remaining allowance, reset date, and warnings
at 80%. At the limit, new records return HTTP 429 with `RECORD_LIMIT_REACHED`
and `Retry-After`; reads and updates to existing records remain available.
There are no overage charges. A queued write racing for the last unit can fail
at persistence; its job exposes `RECORD_LIMIT_REACHED` and can be retried after
capacity becomes available. The database atomically meters successful inserts,
including SDK, API, evaluation execution spans, and imports. Failed transactions
roll back their usage, and concurrent writers cannot overshoot the limit.

Trace retention starts at server receipt, including historical imports. The
ingestion worker runs bounded hourly cleanup; spans/scores cascade with their
trace. Matching ingestion receipts and import history lose their payloads in the
same transaction; receipt tombstones preserve idempotency without restoring expired data.
The same hourly worker removes completed queue payloads after one day and failed
jobs after 32 days, allowing failed quota deliveries to be retried next month.
Traces referenced by datasets, saved evaluations, or review sessions are
pinned and preserved. Cleanup neither deletes that curated evidence nor refunds
usage. Existing traces receive a full retention window from migration time.
Downgrading applies the shorter retention window when the new plan takes effect;
previously expired records cannot be recovered by upgrading later. Keep the
worker running for retention cleanup. Self-hosted mode disables metering,
subscription enforcement, and retention cleanup; restart all web/worker
processes after changing billing mode.

Cloud plans use the limits described above, without automatic usage overages.
Model-provider and sandbox-compute costs use customer provider accounts unless
managed execution is enabled. See [managed execution](managed-execution.md).

Trials are off by default. `DATOOL_BILLING_TRIAL_DAYS` accepts 0–30 days. When
enabled, only a Stripe customer with no subscription history gets a trial; a
card is collected only when payment is due. The unit of billing is an
organization, not a user/project.

Checkout accepts Stripe promotion codes. For complimentary access, create a
100%-off coupon with duration `forever`, restricted to the configured Core/Pro
products, and a private promotion code with an appropriate redemption limit.
Redeem it through the organization's billing checkout to retain the existing
customer mapping and plan limits. A fully discounted checkout does not require
a card; access still depends on the verified active subscription. Returning to
billing replaces open checkout sessions that lack promotion-code support or
still require a card when nothing is due.

## Access and lifecycle

Only owners/admins of the session's active organization can create Checkout or
portal sessions. Members can read subscription status. Tenant membership and
same-origin mutation checks precede any Stripe write. Plans resolve to configured
server-side price IDs. Client-supplied prices/customer IDs are never accepted.

An active or trialing subscription to a configured price grants access only
through its actual Stripe subscription item's current-period end. Incomplete,
expired, unpaid, paused, canceled, missing, or unrecognized subscriptions
do not grant access. A `past_due` subscription gets seven days of grace only
when it has a previously paid, positive-value invoice and an open renewal
invoice. Grace begins at the oldest open renewal's finalization time (creation
time fallback), not webhook delivery time. Duplicate events, retries, and later
unpaid invoices cannot extend it. First-payment failures receive no grace.
Paying the outstanding invoice restores access and clears the recovery warning.
Billing displays the grace deadline, next retry when available, and an Update
payment method action through Stripe's portal. A scheduled cancellation retains access until period end.
Billing and organization selection remain reachable to recover a subscription.
Organizations with billing history cannot be deleted through the auth API; an
operator must archive them after cancellation. This preserves the customer
mapping and prevents orphaning a recurring Stripe charge.

Checks apply to project pages, project APIs, trace ingestion, SDK/CLI REST calls,
and MCP requests. Updates can finish while the monthly record cap is reached; new records still require subscription access. Access checks reconcile stale
subscription snapshots after five minutes and at period expiry; failures cannot
silently grant access. The Billing status refresh also reconciles immediately.

Checkout uses a per-organization database lock, durable customer mapping, Stripe
idempotency keys, and reuse of open sessions to avoid duplicate subscriptions.
Verified webhooks fetch current Stripe state under the same lock, rather than
trusting delivery order. Event receipts are persisted only after synchronization;
processing failures return 500 for Stripe to retry. The success query string is
only a UI hint and never authorizes access.

## Background subscription reconciliation

The existing ingestion worker (`bun run worker:ingestion`, Dokku's `worker`
process) checks for due Stripe synchronizations on startup and every minute when
`DATOOL_BILLING_ENABLED=true`. No extra service or cron configuration is required.
Keep the worker running; deploy migration `0039` before restarting web and worker.
Self-hosted mode does not start this job or require Stripe credentials.

Every successful Stripe synchronization, including webhooks and Billing-page
refreshes, schedules the next background check 15 minutes later. The worker
reads the current subscriptions for the already-linked Stripe customer and
updates Datool's saved subscription, plan, limits, cancellation and payment
recovery fields. It never changes Stripe subscriptions, charges customers, or
changes usage counters. Organizations without a linked customer are skipped.

Due times and consecutive failure counts are stored in PostgreSQL. On failure,
the last verified billing record and its `synced_at` remain intact. Retries back
off by 1, 2, 4, 8, then 15 minutes; they continue at 15 minutes until recovery.
A successful webhook or foreground refresh also clears the failure count.
Restarts preserve the schedule and immediately resume overdue work.

Each sweep selects at most 50 due organizations, oldest first, and stops starting
new work after 45 seconds. Larger backlogs continue on subsequent minute ticks,
so 15 minutes is the normal refresh interval, not a strict freshness guarantee
during outages or backlog. The shared per-organization advisory lock prevents
overlapping checkout, webhook, and reconciliation requests. Competing workers
skip busy organizations and recheck the due time under the lock. Shutdown stops
new work and waits for the current organization to finish.

The worker emits these structured operational log events, without Stripe
payloads, keys, or customer contact details:

| Event | Meaning |
| --- | --- |
| `billing_reconciliation_sweep` | Heartbeat with scanned, synced, failed, and skipped counts. |
| `billing_reconciliation_failed` | Organization ID, consecutive failures, next retry, and `requiresAttention`. Three or more failures emit an error. |
| `billing_reconciliation_recovered` | An organization recovered after three or more failures. |
| `billing_reconciliation_error` | The organization attempt or retry-state write could not finish. |
| `billing_reconciliation_sweep_failed` | The worker could not read due work; it retries on the next tick. |

In your configured Google Cloud Logging project, select the installation's
`generic_node` resource, namespace and node ID, then filter container
`datool.worker.1` and `jsonPayload.message:"billing_reconciliation_"`. Inspect
log freshness as well as failures; a stopped worker cannot emit errors. These
are operational log signals; email/Slack notification policies are not configured
by this job. The read-only CMS continues to show the saved last Stripe sync time.

## Payment recovery setup

In Stripe → Settings → Billing → Subscriptions and emails:

- Enable failed-card-payment and expiring-card emails, using Stripe's hosted
  payment-method update page.
- Enable four Smart Retries within one week.
- Keep the outstanding invoice available for payment. If retries are exhausted,
  leave the subscription `past_due`; Datool independently ends access at the
  seven-day deadline, while the customer can still recover by paying.
- Repeat these settings in the live account; sandbox settings do not transfer.

The app's seven-day access grace is enforced independently of Stripe's retry
schedule. The Datool sandbox has reminder emails and four retries within one
week configured; sandbox email settings are not proof of email delivery.

## Tests

Use a disposable loopback PostgreSQL database, distinct from `DATABASE_URL`:

```sh
DATOOL_TEST_DATABASE_URL=postgresql://datool:datool@127.0.0.1:19433/datool \
  bun --no-env-file test tests/billing.test.ts tests/billing-reconciliation.test.ts tests/launch-access.test.ts
bun run check:styles
bun run typecheck
```

The integration test applies all migrations in an isolated schema. It covers
owner/member/outsider permissions, missing sessions, cross-origin requests,
invalid plans, concurrent Checkout requests, expired sessions, signature
validation, duplicate deliveries, failed synchronization and retry, paid access,
scheduled cancellation, past-due/expired/missing subscriptions, public-signup
verification, and disabled billing without Stripe credentials. It also exercises a fresh
Google callback with only the external token exchange mocked, organization and
project creation, API key creation, first trace ingestion, and a persisted
AutoEvals evaluation. Billing tests cover concurrent quota boundaries, atomic
rollback, retries, UTC monthly resets, upgrades, retention, pinned datasets,
renewal grace, recovery, and access after grace expiry.

The reconciliation test uses isolated PostgreSQL with only Stripe's external
responses replaced. It verifies missed cancellation/plan/deletion events, CMS
visibility, persisted retry delays, failure recovery, duplicate-worker exclusion,
bounded backlog draining, startup/restart, the real one-minute polling timer,
graceful shutdown, and disabled mode without Stripe credentials.

The browser stories exercise usage warnings/limits and active/expired payment
grace in addition to loading, errors, retry, cancellation, and member access.

For an actual sandbox end-to-end run, point a local app at a separate test
database and Stripe sandbox. Forward real Stripe events using:

```sh
stripe listen --all-snapshot --forward-to http://localhost:3007/api/billing/webhook
```

Use the listener's signing secret, then follow `/pricing` → `/billing` → Checkout.
Use Stripe's declined card `4000000000000002`, verify protected APIs still return
402, then retry with `4242424242424242`. Verify a persisted subscription, webhook
receipts, 200 from protected APIs, portal cancellation, and the displayed access
end date. These are test cards only; no real money moves in a Stripe sandbox.
