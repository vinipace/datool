# Managed execution

Core includes US$5 and Pro includes US$25 in shared organization execution
credits per paid subscription month. Datool Scorer Model and Datool Sandbox
use the same balance. Subscription pricing and execution credits are in USD.

## Setup

1. Apply existing billing migrations and `0041_execution_credits.sql` with
   `bun run db:migrate`.
2. Configure Cloud billing and approved monthly Stripe prices normally.
3. Set `DATOOL_SCORER_OPENAI_API_KEY`, `DATOOL_MODAL_TOKEN_ID` and
   `DATOOL_MODAL_TOKEN_SECRET`. These stay on the server, never in project key
   records or sandbox environments.
4. Set `DATOOL_MANAGED_EXECUTION_ENABLED=true` and restart the API and workers.
5. A verified paid invoice grants credits on the next existing billing sync.
6. Select **Datool Scorer Model** in a scorer's Model field. For code scorers,
   add **Datool Sandbox** in project settings and make it the default.
   Organization **Usage** shows the balance and breakdown.

In managed mode, old scorers using the unscoped server `OPENAI_API_KEY` must
explicitly select Datool Scorer Model or a configured project provider. This
closes the unmetered legacy route. Self-hosted installations with managed
execution disabled retain their existing behavior.

## Rates and bounds

Rates are versioned in each operation; changes require a new rate version.
GPT-6 Luna standard rates are US$0.10 / million input tokens, US$0.01 / million
cached input tokens, and US$0.50 / million total output tokens. Reasoning is
already included in output. Each HTTP attempt reserves US$0.003648, then
settles from provider usage. Retries are independent attempts. The transport
fixes endpoint, model, standard tier and 4,096 output-token maximum. Complete
input is limited to 12 KB. Streaming, images, stored conversations and hosted
tools are excluded. Bundled classifier function schemas do not execute tools.

Sandbox allocation is one physical CPU and 256 MiB, with network blocked,
a 30-second provider lifetime and existing worker execution bounds. The
customer tariff is US$0.00003942 per CPU-second plus US$0.00000667 per GiB-second.
It measures time from the returned sandbox handle through confirmed
termination, including teardown. US$0.0049305 reserves 120 seconds of this
tariff; the unused amount is released.

This is a **Datool execution tariff**, not a claim that Modal's invoice equals
the deduction. Startup, minimum billing and invoice adjustments may differ.
`providerInvoiceCost` stays null until invoice evidence exists. Credits are
also separate from TokenLens analytics estimates. Rate references:

- [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)
- [Modal Sandbox pricing](https://modal.com/pricing#sandbox)
- [Modal resources and billing](https://modal.com/docs/guide/sandbox-resources)

No rollover, trial credits, payment-grace credits or automatic overage. No
prorated grants on upgrades/downgrades: the next full paid period receives the
new allowance. Late settlement always belongs to the original period, even
after renewal or cancellation. Exhaustion never silently switches providers.

## Recover uncertain operations

Unknown provider outcomes are not automatically refunded. The first release
uses manual reconciliation rather than guessing a zero cost or reissuing a
potentially accepted request. Usage shows the reservation until reconciled.

With a maintainer database connection:

```sh
bun run scripts/execution-credits.ts pending --organization ORGANIZATION_ID
bun run scripts/execution-credits.ts settle OPERATION_ID --evidence verified-usage.json
```

The evidence file contains `chargedNanoUsd` (one USD is 1,000,000,000),
`providerId` (nullable), `reason`, and `usage`. Verify the outcome using the
provider request/sandbox ID, server lifecycle records or provider support.
Retain token counts or allocation duration and the rate version. A zero charge
requires verified non-billable execution; elapsed time alone is insufficient.
A process crash without a provider ID needs investigation before settlement.
There is no public adjustment API. An identical repeated settlement is safe;
a conflicting amount or a charge above the reservation is rejected.

## Verification

Automated database tests use schema-isolated loopback PostgreSQL via
`DATOOL_TEST_DATABASE_URL`, never the default application schema. Browser
stories cover Usage and both existing selection controls.

For real provider calls, explicitly opt in and supply the intended local test
DB and provider credentials in the process environment:

```sh
DATOOL_LIVE_EXECUTION_CHECK=true bun --no-env-file scripts/verify-managed-execution.ts
```

The check costs less than US$0.03 at the checked-in rates. It creates a marked
test grant in a disposable schema, verifies real execution and shutdown,
writes `.tmp/managed-execution-live.json`, then drops the schema. The report
contains request IDs, credit deductions and saved evaluation evidence, never
credentials. It does not call live Stripe or alter customer balances.
