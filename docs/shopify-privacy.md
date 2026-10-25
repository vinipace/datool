# Shopify lifecycle and privacy operations

Apply migration `0070_shopify_install_lifecycle.sql` before deploying the web
release. OAuth completion registers `app/uninstalled` for each store and the
commerce events allowed by its granted scopes. Reconnect existing stores after
deploying this registration step. It preserves unrelated subscriptions and
does not duplicate matching registrations.

Register `customers/data_request`, `customers/redact` and `shop/redact` in the
released production app configuration:

```toml
[[webhooks.subscriptions]]
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
uri = "https://YOUR_DATOOL_HOST/api/shopify/webhooks/commerce"
```

Datool's standalone app uses the legacy OAuth grant flow. Shopify rejects
ordinary app-specific `topics` subscriptions in that configuration; those are
registered per store by the installation handler instead. Compliance
subscriptions remain app-wide. Endpoint deployment alone does not register them.

The existing receiver verifies the original body through Shopify's official SDK.
Invalid signatures return 401; database failures return 503 for retry. Uninstall
atomically disconnects the matching app/store, clears its credentials and old
browser sessions, removes older unclaimed installation tokens, and requests a
billing refresh. Other apps are unaffected. Receipts prevent duplicate processing;
the recorded installation time protects a new installation from an older event.

## Privacy requests require operator fulfillment

The receiver stores encrypted requests with a 30-day deadline, even after
uninstall or when Build is disabled. It does **not** automatically export or
erase customer records. A 204 response confirms durable receipt only.

Before public launch, assign an operator and verify the complete export/erasure
workflow with disposable store data. Check the pending list daily and complete
requests before their deadline. These commands use the deployment's database
and existing credential-encryption key:

```sh
bun scripts/shopify-privacy.ts list
bun scripts/shopify-privacy.ts health
bun scripts/shopify-privacy.ts export --id REQUEST_ID --output /private/path/request.json
```

`export` writes the **request**, not the customer's collected data. It creates
a new file with mode 0600, refuses to overwrite existing files and never prints
the customer payload. The list contains request IDs, topics and deadlines only.

`health` is read-only and returns aggregate counts and the next deadline, without
request payloads, store domains or customer identifiers. Exit status 1 means a
request is overdue, due within seven days, or the database/configuration could
not be checked (`status: unavailable`). Exit status 0 does not mean there are no
pending requests; inspect `pending` and continue the daily operator review.
Completed requests do not count. Connect this command to the installation's
monitor and verify both failure alerts and a named recipient. Shipping the
command does not install a schedule, deliver an alert, or fulfill a request.

The production image includes the command. For Compose, run it inside the app
container so it uses the deployment's private configuration:

```sh
docker compose exec -T app bun scripts/shopify-privacy.ts health
```

Fulfill the request using its verified store and customer/order identifiers:

- For a data request, collect the relevant customer data and securely provide it
  to the store owner. Verify the recipient independently; do not send it to an
  address merely present in a chat message.
- For customer redaction, remove the customer's data within that store. Include
  guest conversations identified through the supplied order IDs or contact
  details, as well as signed-in customer records.
- For shop redaction, remove that store's data while preserving unrelated stores
  and projects. Check for a newer installation before taking destructive action.

The data inventory includes contacts and their Shopify metadata, visitor/message
identity, conversations and messages, continuations and tool arguments/results,
channel delivery jobs, commerce quotes/results, and associated traces/spans.
Copied evaluation/review/dataset evidence, exports, ingestion queues and backups
also need a documented disposition. Deleting only the Shopify connection is
insufficient. Follow the installation's retention and legal-hold policy where
applicable, and keep private fulfillment evidence outside this repository.

Only after the export or erasure has actually been completed and verified:

```sh
bun scripts/shopify-privacy.ts complete --id REQUEST_ID --evidence INTERNAL_EVIDENCE_REFERENCE
```

This records the operator's completion, removes the request's encrypted payload
and store domain, and retains a delivery tombstone so a retry cannot recreate it.
Use a non-sensitive evidence reference; remove the private request file after
fulfillment. The command does not itself erase customer data or send an export.

Required release proof: registered subscriptions; signed delivery/retry;
uninstall/reinstall; a complete customer export; customer and store erasure
including copied evidence; and a monitored, staffed pending-request process.
Until that proof exists, privacy intake alone does not make the app ready for
public distribution.

References: [Shopify compliance webhooks](https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance)
and [delivery verification](https://shopify.dev/docs/apps/build/webhooks/verify-deliveries).
