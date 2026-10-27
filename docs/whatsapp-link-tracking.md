# WhatsApp replies and link activity

New WhatsApp replies use channel-specific text rendering: product names and prices stay together, links appear on separate lines, and Markdown headings/links/tables become WhatsApp-readable text. The agent's product selection is the message; structured product results are a fallback only when the reply is empty. Missing checkout URLs are still appended. Web product cards are unchanged.

When `DATOOL_PUBLIC_URL` is a public HTTPS origin, the channel replaces up to 20 distinct public HTTPS destinations per message with random, persisted `/l/<token>` links. Credentials, IP addresses, local hosts and custom ports are not eligible for shortening. No destination is fetched by the redirect service. Existing messages are not rewritten or resent.

Links are inserted in the same transaction as the outbound message and job. An idempotent send reuses its message and links. Redirects become available only after the message is marked sent or delivered, expire after 90 days, and are deleted with their message. Tokens contain no customer or conversation identifiers. A redirect uses only the stored destination; query parameters on the short URL cannot override it. Original destination query strings and fragments are retained. Redirects are uncached and suppress referrers.

The Evolution channel's **Link activity** card shows the latest 20 sent links with their conversation and counters. `build_list_channel_links` exposes the same project-scoped data with `build:read` permission.

- **Clicks** counts GET visits, including repeated opens. It is an estimate, not unique people, confirmed engagement or purchases.
- **Auto** counts recognized bots, link previews and prefetch requests. Unrecognized automation can still count as clicks.
- HEAD requests redirect without incrementing either counter.
- These metrics retain counters and the last estimated click time, not visitor IPs, user agents, cookies or fingerprints. Infrastructure access logging is separate.
- A counter-write failure does not prevent an otherwise valid redirect. Expired, unsent or unknown links return 404; service failures return 503.

Validation: `bun --no-env-file test tests/whatsapp-text.test.ts tests/build-channel-presentation.test.ts` and `bun --no-env-file scripts/test-channel-links-e2e.ts` (isolated PostgreSQL through `DATOOL_TEST_DATABASE_URL`). The latter exercises real message admission and the public route without contacting WhatsApp or Shopify. Device delivery and a real user opening the link remain separate release checks.
