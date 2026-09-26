# Internal notifications

`src/server/product-events.ts` is the single place that defines reactions to
product events. Producers call `await emitProductEvent(event)` after the product
action succeeds. Add an event to the `ProductEvent` type and its reaction to the
switch in that file. There is no event broker, outbox, new table or background
notification worker.

## Paid subscription

The verified Stripe `invoice.paid` webhook emits `subscription.activated` for
the subscription's first positive payment. It covers trial conversion, skips
free invoices and renewals, and includes workspace, plan, first payment and a
Stripe link. Stripe test-mode events are labelled as tests.

The existing billing receipt store suppresses repeated Event IDs and repeated
activations for the same subscription. Notification attempts happen after the
receipt is saved. Slack has a five-second timeout and failures are logged as
`product_notification_failed` without payloads or credentials. Delivery is best
effort: a Slack outage or process exit can lose a notification. There is no
automatic replay; billing success never depends on Slack delivery.

Set these server-only environment variables through the deployment's secret
configuration (both web and worker), and restart through the usual release:

- `SLACK_BOT_TOKEN`: Slack bot token with `chat:write`.
- `SLACK_SUBSCRIPTIONS_CHANNEL`: channel ID; invite the bot to that channel.

An empty `SLACK_SUBSCRIPTIONS_CHANNEL` disables subscription notifications even
when the shared bot token is configured. Ensure the Stripe webhook endpoint
includes `invoice.paid`. Keep destination IDs and tokens out of source control.

## Deployment status

CircleCI's deployment job calls `ops/notify-deployment.py`. Set `SLACK_BOT_TOKEN`
and `SLACK_DEPLOYMENTS_CHANNEL` in the existing project/main-restricted `datool-production`
context. Do not expose deployment secrets to verification or pull-request jobs.
An empty `SLACK_DEPLOYMENTS_CHANNEL` disables deployment notifications. The
subscription and deployment destinations are independent; no channel ID is
hardcoded. Configure the subscription destination in the app environment and
the deployment destination in CI.

After checking the image artifact, the deployment attempt starts one Slack
message. Success follows web/worker and public-route checks; any subsequent job
failure produces a failure reply. The ephemeral runner state records the parent
`thread_ts`, deployment identity and posted statuses. A rerun is a new deployment
attempt with its own thread. The script never changes the deployment exit status.

These are CI deployment notifications; manual imports must invoke the same
script before and after their deployment command to get the same behavior.
Use one state file and deployment ID for that attempt. Do not run it twice from
different machines for the same attempt. Keep the file until all statuses finish.

Delivery is best effort. If Slack's parent acknowledgement is lost, the script
does not create another parent on a later call. It logs
`deployment_notification_failed`; inspect Slack and CI before retrying. If the
runner is killed, cancelled or times out, final notification steps might not
execute. CI remains the source for authoritative deployment status.

## Verification

Use a disposable local PostgreSQL database for the billing tests:

```sh
bun test tests/product-events.test.ts tests/product-events-billing.test.ts
python3 -m unittest discover -s tests -p 'deployment_notifications_test.py'
```

For live notification testing, use a clearly labelled synthetic event; do not
create a charge or subscription. Verify the Slack parent and reply before
reporting delivery as active. Useful additional product events are payment
failure, subscription cancellation and first workspace activation. Enable them
only when their definitions and destination are agreed.
