# Official WhatsApp through Zernio

Datool can use Zernio's Meta Cloud API integration for newly created official WhatsApp channels. Existing direct Meta and Evolution channels keep their current provider. Each Datool channel has a dedicated Zernio profile; callback account IDs are checked against that profile before the number is bound to a project.

## Installation

Set these server-only variables on both the web and Build worker processes:

- `DATOOL_PUBLIC_URL`: the public HTTPS origin of the Datool installation.
- `DATOOL_ZERNIO_API_KEY`: a Zernio API key with access to profiles, accounts, inbox, WhatsApp media and webhooks.
- `DATOOL_ZERNIO_WEBHOOK_SECRET`: a random, independent signing secret, also configured on the Zernio webhook.

Apply migrations before starting either process. Configure a Zernio webhook targeting `https://<public-origin>/api/build-webhooks/zernio` with the same secret and the events `message.received`, `message.sent`, `message.delivered`, `message.read`, `message.failed`, and `account.disconnected`. Verify a signed test webhook before connecting a customer number. Never expose the API key or signing secret to a browser or a customer project. Scope staging and production webhook subscriptions to their own Zernio profiles where possible.

The customer starts Meta's signup in the WhatsApp channel settings and selects Cloud API or coexistence with the WhatsApp Business app. The latter may require scanning a QR code in Meta's signup flow; this is different from the Evolution connection. A number already bound to another Datool WhatsApp channel must be disconnected there first. Meta and Zernio eligibility, profile limits, and fees apply.

Received image and audio attachments are downloaded from Zernio only after an authenticated webhook, scoped to the account and conversation. Audio transcription uses the project's Vercel AI Gateway key and records provider usage in the same way as existing agent calls. Do not configure a separate server transcription key. Outbound free-form messages require an open 24-hour customer-service window. Templates require documented consent and Meta approval.

A successful API response is not proof of delivery. Validate provider delivery receipts and the recipient's device in a real test. Account-disconnect events mark the channel unavailable; a successful webhook test or an old connected status does not prove the number remains online. The Disconnect action disconnects the Zernio account and stops routing in Datool; it does not delete the phone number itself.

For local regression, start a disposable PostgreSQL database with pgvector and run `DATOOL_TEST_DATABASE_URL=postgresql://... bun --no-env-file scripts/test-zernio-integration.ts`. Provider and Gateway calls are simulated in this test; it sends no real WhatsApp messages.
