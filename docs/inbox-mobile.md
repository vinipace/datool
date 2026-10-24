# Datool Inbox mobile backend

The native app uses the existing Better Auth Google and email-link providers.
The server trusts only the `datool-inbox://` native scheme in addition to its
configured web origin, and the Expo server plugin transfers the resulting
session cookie back to the app. Deploy this support before distributing a native
build; an older server rejects the native callback with `INVALID_CALLBACK_URL`.

The authenticated `/api/inbox-mobile/projects` endpoint lists eligible workspaces.
`/api/inbox-mobile/devices` manages device subscriptions tied to a live human
session. Existing Build operations serve tickets, messages and human replies.
The installation and organization Build gates, membership and billing checks
remain in force.

Migration `0071_inbox_mobile.sql` captures handoffs and assignments transactionally.
The existing Build worker expands them into per-device jobs and checks membership,
subscription, session validity, current ownership and billing again before sending.
Provider tickets and receipts are retried durably. A receipt proves provider
acceptance, not display on a phone. Notifications contain generic copy and a
ticket destination, without conversation content.

Apply migrations through the normal release command and restart both the web
process and Build worker. Configure APNs for the native app in Expo. If Expo push
security is enabled, provide `EXPO_ACCESS_TOKEN` only to the Build worker; never
include it in public mobile environment variables.

Validate a release by starting sign-in with `datool-inbox:///`, checking that
untrusted callback schemes remain rejected, and checking that both mobile API
routes reject anonymous requests with JSON 401 responses. Complete Google sign-in
on a device, open a workspace and verify a subscribed handoff notification before
claiming the complete mobile journey works.

The first native build uses `https://trydatool.com`, while Cloud authentication
uses `https://www.trydatool.com`. The browser authorization bridge redirects to
the configured auth host before setting its host-only OAuth cookie. Cloud also
accepts the exact HTTPS apex origin for native API mutations. This exception is
limited to the configured Cloud origin; self-hosted installations keep their own
origin and do not trust arbitrary subdomains.
