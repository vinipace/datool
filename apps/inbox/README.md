# Datool Inbox

Expo app for the people who take over conversations from Datool agents. It uses the existing helpdesk tickets, ownership leases, channel outbox and human authentication. Belll's Expo Router, SecureStore, notification linking and durable push/receipt patterns informed the setup; this app has its own identifiers and credentials.

## Run locally

Install the server from the repository root with `bun install`. Install the app separately so its React Native/React versions stay independent of Next.js:

```sh
cd apps/inbox
npm ci
cp .env.example .env.local
npm start
```

Set `EXPO_PUBLIC_API_URL` to your Datool server's origin. Production requires HTTPS. A physical phone needs a reachable server URL; `localhost` refers to the phone itself. Configure the server's `BETTER_AUTH_URL` to match that origin. The app uses the server's configured Google/email-link sign-in and organization permissions, with cookies stored using SecureStore on native devices.

Use an Expo development build for native authentication and push notifications. `npm run web` is useful for layout previews, but the app is intended for iOS and Android; it does not install a web offline service worker. New native dependencies require rebuilding the development client.

## Appearance

The dark chat layout follows the supplied WhatsApp references: circular avatars, edge-to-edge conversation rows, search and filter pills, green outgoing bubbles, a clean dark conversation background, and a compact composer that follows the keyboard. Expo Router's native tabs provide system Liquid Glass on iOS 26, native navigation on older iOS and Android, and persistent Chats/Outbox/You screens. The browser preview uses a separate frosted tab bar.

The inbox title is the selected project name, using a single line with the large title typography. Tap it to open the native project drawer; long titles truncate in the header and wrap inside the drawer. The current project has a checkmark, organizations distinguish similarly named projects, and cached projects remain available offline. Changing projects clears the previous agent/search filters; dismissing the drawer or selecting the current project preserves them.

The project scope is owned by the parent workspace route and shared across Chats, Outbox and You. Native tab presses can replace a child screen’s parameters; they must not change the project or its cache keys. The project drawer replaces the whole workspace route when switching projects. Regression checks should include Chats → Outbox → Chats and Chats → You → Chats on iOS, then repeat with the API unavailable: the selected title and cached conversations must remain visible. Browser tabs use a different navigator and do not reproduce this native parameter-loss bug.

Avatars use twelve contrasting color pairs, six bold geometric backgrounds and larger, bold first/last initials. Light and dark palettes use matching dark or white text for legibility. Color and artwork follow the contact ID across the inbox, conversation and contact profile, independent of list order or name edits; workspaces use rounded squares. All fallback artwork renders locally and works offline. Profile photos keep that fallback visible while loading or if the image fails. Floating channel badges use bundled app logos: white-on-green WhatsApp, Telegram’s white plane on blue, Instagram’s gradient camera, the blue Messenger bubble and Slack’s multicolor mark. A consistent outer ring separates each badge from the avatar. Web, email, API and helpdesk use neutral symbols; email does not imply Gmail or another provider. See [artwork sources](assets/brands/README.md).

The You tab centers the user's profile above rounded settings groups. It supports settings search, editing the account name, workspace notification preferences, and access to saved replies. Profile images use the authenticated user's photo when available, with initials as the fallback. Tapping a conversation’s avatar or name opens a full contact screen with a centered avatar, floating channel badge, real phone/email details when available, and grouped ticket information. Message returns to the existing draft; Manage opens the conversation actions. Loaded contact details are cached for offline use. Helpdesk actions live in a native details sheet; only real queue counts and submission states are shown. The app does not infer read receipts or unread counts.

## Inbox and conversations

- Choose a workspace, filter by agent and Open/Mine/Unassigned/Solved, search, and load older tickets/messages.
- Open a ticket, join its human lease, reply, return control to the AI agent, or solve/reopen the ticket.
- Team handoffs can be claimed; a live lease held by another person is protected.
- Replies use the existing channel delivery pipeline. “Submitted to Datool” means server admission, not customer delivery.
- This first version sends text replies. Existing images, attachments and widgets display placeholders where native rendering is unavailable; full content remains in the web inbox.

## Offline behavior

Sign in and open an inbox/conversation online once to save it. Previously loaded views and messages are available offline. The cache expires after seven days without a new snapshot. An unseen view needs connectivity.

Replies are written to an independent persistent outbox **before** clearing the composer. They survive process restarts and retain the original client message/idempotency ID through retries. Sync resumes when connectivity returns while the app is active; reopen the app to resume after closing it. Delivery in the background or after force-quitting is not scheduled.

Each conversation keeps reply order. Network/server failures back off automatically; another conversation can still sync. Sign-in, permission and ownership conflicts pause the affected conversation and show **Needs attention** in Outbox. An expired lease is renewed only if the server still identifies the same person as owner. Open/join the conversation as appropriate, then retry. No automatic takeover of another person occurs.

Outbox lets you inspect, retry or remove saved replies. Removing one cannot recall an earlier request that already reached the server. Sign-out requires pending replies to be sent or removed and clears cached conversations. Queues are isolated by server and user; signing in as another user never sends the former user's replies.

The outbox allows 500 pending replies per installation. It has no time-based expiration for pending replies. Inbox snapshots, drafts and queued message content use local AsyncStorage, which is not encrypted by the app; native authentication credentials stay in SecureStore, and session tokens are excluded from inbox snapshots. Uninstalling the app or clearing app storage removes unsent replies.

## Backend and handoff alerts

Before using the app against a server, apply repository migrations including `0061_inbox_mobile.sql` and restart the web app and Build worker:

```sh
bun run db:migrate
bun run worker:build
```

Configure the server's usual database, auth, billing and Build prerequisites. The new `/api/inbox-mobile/projects` and `/api/inbox-mobile/devices` endpoints require a human session. Conversations use existing `/api/build/*` operations.

Handoff/assignment events enter a durable queue in the same database transaction as the source event. The Build worker fans out alerts only to subscribed devices: the assigned person, the current human owner, the ticket's team, or workspace subscribers for an unassigned handoff. Membership, assignment, session, subscription and billing access are checked again before sending. Revoked/expired sessions cannot receive new sends. Notifications contain only generic copy and a ticket destination, without customer messages.

Push failures retry with bounded backoff. Expo tickets are checked for receipts; invalid device tokens are removed. `accepted` means provider acceptance, not device display. Ambiguous provider outcomes can produce a repeated alert. This queue covers handoffs and assignments, not every new customer message.

## App diagnostics

The app reports failed Google/email sign-in, session reads, API requests and caught screen-render errors through `/api/inbox-mobile/diagnostics`. Google callback failures show a retry message, and native Google sign-in verifies that a session exists before treating the browser return as success. These changes help identify and recover from failures; they do not establish successful Google sign-in on a physical device.

Configure `INBOX_DIAGNOSTICS_PROJECT_ID` **on the server only**, using the ID of an existing project selected by the operator. The destination is fixed regardless of the agent's selected inbox project. No API key belongs in the app. Deploy the collector before releasing the updated mobile app; an unset destination disables admission with HTTP 503. A new native release is required for installed clients to start reporting.

Reports appear in **Traces**, with operation `inbox.app_error`, status `errored`, and `service.name=datool-inbox`. The allowlisted fields are a random report ID, timestamp, error stage/code, optional HTTP status, app version/build, platform and connection state. Free-form error messages, stack traces, callback URLs, credentials, customer messages and user identities are excluded on both sides. Reports are marked `diagnostic.source=unverified-client`: the collector accepts reports before login, so they must not be treated as trusted audit evidence. This is handled-error reporting, not native crash capture or complete JavaScript exception coverage.

Diagnostics use a separate persistent queue with at most 30 reports, expiring after seven days. Repeated failures are coalesced for one minute. Reports retry while the app is active, on foregrounding and on reconnection; a successful receipt means the trace has committed to PostgreSQL. Retries retain the original ID and do not duplicate traces. Reporting failures never block sign-in or the customer outbox. The collector validates a 4 KiB request limit and uses Redis to cap admission globally at 60 reports per minute and 1,000 per day per configured destination.

An isolated release snapshot must include `src/lib/inbox/diagnostics.ts` at the repository-relative path as well as `apps/inbox` and the theme token source. Metro watches this shared wire contract; copying only the app directory is insufficient.

Validation uses `bun --no-env-file test apps/inbox/tests/diagnostics.test.ts` for queue durability and redaction, the existing login browser regression for callback/retry/reporting behavior, and `tests/inbox-diagnostics.test.ts` with separate loopback PostgreSQL and Redis services for admission, project isolation and persisted trace receipts. Production verification must additionally read a synthetic report back from the selected project and exercise Google login on the installed build.

## Link and build the native app

The bundle identifier is `com.datool.inbox` and the callback scheme is `datool-inbox`. Confirm these identifiers in your developer accounts before the first release.

1. The app is linked to the dedicated Expo project `@vinpac/datool-inbox` (`5204541c-1d7d-42a9-bb64-73a6483fdf77`) in `app.config.ts`. Keep that ID separate from Belll. Its Apple bundle identifier is `com.datool.inbox`.
2. Use the canonical `https://www.trydatool.com` for `EXPO_PUBLIC_API_URL`. Older EAS environment values using `https://trydatool.com` are normalized before requests; the existing offline storage namespace is retained so queued replies and cached inboxes remain accessible. Deploy the mobile backend routes, auth changes and migration before testing against it. Configure APNs and FCM credentials through EAS. For Android, supply `GOOGLE_SERVICES_JSON` as an EAS file environment variable for this app.
3. Run `npx eas-cli@latest build --profile development --platform ios` (or `android`). The `simulator` profile builds an iOS simulator client; push should be checked on a physical device. `preview` and `production` profiles are also included.
4. On the phone, sign in, open a workspace, choose **You → Notifications**, and enable alerts. Tapping an alert opens its ticket after authentication. Existing opt-ins refresh tokens on activation.
5. If Expo push security is enabled, set `EXPO_ACCESS_TOKEN` **only on the Build worker**. Never expose it through an `EXPO_PUBLIC_*` variable.

## Local iOS releases

Paid EAS cloud builds are optional. Build on a Mac with Xcode 26.4+, CocoaPods and Fastlane, then upload the resulting IPA with Apple Transporter/Xcode or the free EAS Submit service:

```sh
EXPO_PUBLIC_API_URL=https://www.trydatool.com bunx eas-cli@23.2.0 build --platform ios --profile production --local --output ./datool-inbox.ipa
npx eas-cli@latest submit --platform ios --profile production --path ./datool-inbox.ipa
npx eas-cli@latest submit:status --platform ios --profile production --json --non-interactive
```

The dedicated App Store Connect record is `6826460773`. On October 23, 2026, locally built version **1.0.0 (5)** was uploaded through free EAS Submit and Apple reported `VALID` / `IN_BETA_TESTING` for internal testing. The production mobile backend and native callback compatibility fixes were subsequently deployed through PRs #42 and #43. Live checks confirmed callback admission, the canonical browser cookie host and native mutation origin handling. This does not establish complete device sign-in, push display or live inbox behavior. Build and submit from an isolated source snapshot when the repository contains unrelated work. Local builds do not consume the EAS cloud build quota. EAS CLI still uses the configured project and managed signing credentials; direct Xcode and Transporter uploads are alternatives.

If Xcode reports a missing Push Notifications capability despite a signed profile containing `aps-environment`, inspect its cached team capability list under `~/Library/Developer/Xcode/UserData/Capabilities/`. Back up a stale cache before letting Xcode regenerate it; do not strip the app's push entitlement or revoke shared signing credentials. The initial release encountered this exact cache issue.

The next local release, **1.0.0 (7)**, includes the updated sign-in design and connection recovery. Public sign-in options load without reading stored credentials, offline startup shows a retry action, authentication requests have a 20-second deadline, and connectivity is refreshed on foregrounding. App lint/typecheck, both browser regressions, four durable-outbox tests, the style contract and all 20 Expo Doctor checks passed. Its verified signed IPA was uploaded to the existing internal tester group, and Apple reported `VALID` / `IN_BETA_TESTING` for build 7. Physical-device sign-in on this new build remains to be checked. Release evidence is saved under the ignored `artifacts/inbox-mobile/release/` directory.

TestFlight release **1.0.0 (8)**, includes the single-line project selector, distinct contact avatars, bundled WhatsApp/Telegram/Instagram/Messenger/Slack logos, and the chat keyboard/contact-profile refinements. It was built locally from isolated source snapshot `8ff62299cad641eece100ac5a15cde88106a102b`, then submitted to the existing **Team (Expo)** internal tester group. The IPA signature, production push entitlement and production API endpoint were verified before upload. Apple reported `VALID` / `IN_BETA_TESTING` on October 24, 2026. Physical-device testing of this signed build remains separate from the completed simulator/browser checks. Evidence is in `artifacts/inbox-mobile/release/design-release.json`.

TestFlight **1.0.0 (9)** fixes project scope disappearing after native tab changes. Chats and project notification settings now use the parent workspace route, and selecting another project replaces that entire route. The failure was reproduced in the iOS simulator before the fix; tab switching, explicit project changes, failed refreshes with cached conversations, and background/foreground recovery passed afterward. The existing browser regression, app/root typechecks, app lint and style contract passed. The signed IPA contains the new workspace-scope code and production push entitlement. Apple reported `VALID` / `IN_BETA_TESTING` on October 24, 2026 after submission to **Team (Expo)**. Source snapshot: `ad6f48fa7070674cc1e87d55d9d50f122c062afc`; release evidence: `artifacts/inbox-mobile/release/project-scope-release.json`. Physical-device verification of build 9 remains separate.

Cache restoration also needs a JSON-safe first-page marker. Persisted infinite-query `pageParams` turn `undefined` into `null`; the installed query library preserves that value on refresh. Inbox and message queries now keep `null` internally and omit it from the API's optional `cursor`/`before` fields. This repairs existing saved caches without clearing conversations or the outbox. The browser regression restores the real persisted cache, requires fresh inbox content after restarting, and verifies new messages arriving after an offline restart. Its API fixture rejects null cursors like production; the inbox scenario failed before this fix and passes afterward.

TestFlight release **1.0.0 (10)** includes both fixes. The rejected cursor was also reproduced against the production read API, matching the HTTP 400 response from build 8. The iOS simulator recovered its existing cache with the new code and loaded fresh inbox content. App lint, app/root typechecks, the style contract and the full browser regression passed. The verified signed archive was submitted to **Team (Expo)**; Apple reported `VALID` / `IN_BETA_TESTING` on October 24, 2026. Source snapshot: `c41fcee75264d7c18425e98259b9217327a05bf1`; evidence: `artifacts/inbox-mobile/release/cache-refresh-release.json`. Physical-device confirmation remains pending.

TestFlight release **1.0.0 (11)** added Google callback error messages, a session check after the native browser returns, and a bounded local diagnostic queue. A Release simulator build reached Google, showed a retry message when sign-in was interrupted, and persisted the sanitized diagnostic. App typecheck and lint passed; the signed IPA's version, production API origin and push entitlement were verified. Built locally from isolated source `dec3762ab81b904b9ff912722b4012e5b46e47cd`, it was submitted to **Team (Expo)** and Apple reported `VALID` / `IN_BETA_TESTING` on October 25, 2026. Evidence: `artifacts/inbox-mobile/release/auth-diagnostics-release.json`. Forwarding diagnostics to the selected Datool project still requires server configuration and deployment. Authenticated Google callback completion and physical-device behavior remain unverified.

The current TestFlight release, **1.0.0 (12)**, fixes a reproduced silent return to login after a successful native callback followed by an API 401. API failures now revalidate the current session instead of deleting it immediately; confirmed expiry displays a recovery message, while valid sessions retain the screen and its retryable error. Native Google completion publishes the verified identity after cancelling older session reads. Sign-out and email completion retain the root session observer. Requests use the canonical production host and native cookies from SecureStore, with existing offline storage keys preserved. The native synthetic callback, rejected request, expiry, reauthentication and sign-out checks passed; the new browser regression failed against build 11 and passed after the fix. Existing inbox/login regressions, durable queue tests, app lint/typecheck and style checks passed. Built locally from isolated source `63c6b91ec1e35dcc99f87749021a1d5309ef0d97`, submitted to **Team (Expo)**, and verified by Apple as `VALID` / `IN_BETA_TESTING` on October 25, 2026. Evidence: `artifacts/inbox-mobile/release/session-recovery-release.json`. The loopback host-redirect test retained its cookie, so cookie loss is not established as the production root cause. Real Google token exchange, physical-device success, and production diagnostic ingestion remain unverified.

## Checks and verification boundary

```sh
# In apps/inbox
npm run sync:theme
npm run typecheck
npm run lint
npx expo install --check
npx expo-doctor
npx expo export --platform all

# From the repository root
bun run typecheck
bun run check:styles
bun --no-env-file test apps/inbox/tests/outbox.test.ts
# Set DATOOL_TEST_DATABASE_URL to an isolated PostgreSQL test database first:
bun --no-env-file test --timeout 30000 tests/build-inbox-mobile.test.ts tests/build-inbox-queues.test.ts tests/build-operations.test.ts tests/auth-configuration.test.ts
```

For the repeatable browser regression, start `EXPO_PUBLIC_API_URL=http://localhost:3000 npm run web -- --port 19069`, then run `npm run test:ui` in another terminal. It uses the root Playwright installation, intercepts API requests with synthetic data, and saves screenshots to the ignored `artifacts/inbox-mobile/` directory. The offline fixture keeps Metro assets reachable while blocking API access, simulating a native app whose JavaScript is already installed.

Run `npm run test:auth-ui` against that preview for the signed-out flow: provider loading and recovery, interrupted Google sign-in, email validation, pending controls, a failed request that preserves the address, sent/resend/change-email states, and phone/tablet layouts. These use synthetic auth responses and do not send mail or complete OAuth. Screenshots are saved under `artifacts/inbox-mobile/login/`.

Native Google checks must also use a development client and a Release simulator build with the production API origin. Start Metro in the app's own checkout with its own installed dependencies: symlinking `node_modules` into an isolated snapshot can break the lazy browser bundle even when the embedded Release bundle works. Verify that Google opens, closing the browser produces a retry message, and retry opens the native sign-in prompt again. Check the local diagnostic queue for `google_session` / `SESSION_MISSING` without cookies or identity fields. Completing Google sign-in and restoring its authenticated session requires an authorized test account; merely opening Google does not prove that return path.

For session lifecycle regressions, run `node tests/session-recovery.e2e.mjs` against the web dev server on port 19069 with `EXPO_PUBLIC_API_URL=http://localhost:3000`. It checks that an API 401 triggers a session recheck, a valid login stays active, and a confirmed missing session produces a recovery message. `bun --no-env-file test apps/inbox/tests/server-origin.test.ts` separately protects the canonical production origin and compatibility with existing offline storage keys.

The native counterpart is `node apps/inbox/tests/native-auth-server.mjs` plus a development client using `EXPO_PUBLIC_API_URL=http://localhost:19072`. This standalone fixture exercises the real iOS browser callback, secure cookie storage, session request and navigation with synthetic identity only. Select its scenario by POSTing `{ "mode": "api-401" }` to `/__scenario`, then complete the browser sign-in: Workspaces must remain visible with a retryable API error. Resetting that scenario invalidates the synthetic token; tapping Try again must show a session-ended message on the login screen. The `success` scenario verifies reauthentication, and `/__events` records paths and authentication booleans without cookies. Restart Metro after source edits when using CI mode, which disables file watching. These tests do not establish successful Google provider token exchange or physical-device behavior.

The welcome and email screens share a bundled photographic background (`assets/login-background.jpg`, approximately 287 KB), safe-area spacing, scrollable keyboard-aware forms and accessible sign-in controls. The welcome screen shows only providers enabled by `/api/auth/config`. Email sign-in keeps the native secure-state callback; web uses a browser callback without calling native SecureStore. Artwork provenance and the generation prompt are in `assets/login-background.md`. Typechecks, lint, style checks, browser auth checks and an iOS export passed; physical-device sign-in and a fresh native keyboard check remain unverified while the host Mac is locked.

Colors are generated from the dedicated `--inbox-*` dark tokens in `app/globals.css`; edit those tokens, then run `sync:theme`. These tokens leave the web product palette unchanged. Native reusable controls live in `src/components/`.

The PostgreSQL tests cover committed handoffs, recipient authorization, concurrency, retries and receipt handling with a mocked Expo provider; HTTP tests exercise real Better Auth sessions. Outbox tests use durable disk storage. Browser checks use synthetic API data to exercise cached reload, offline replies, ordered reconnection, stable retry IDs, ownership conflicts, queue removal confirmation, persistent tabs, settings search, profile save/retry/cancel, and phone/tablet layouts. The account, inbox and conversation layouts were visually checked in Expo Go on an iOS 26.4 simulator, including the native Liquid Glass tabs, before the Claude design refinement described below. These are local checks, not proof of production deployment, native keyboard/gesture behavior, live channel delivery or physical-device push.

The subsequent Claude design review refined the WhatsApp-style palette, row density, grouped message bubbles, ownership actions, profile groups and floating channel badges. App and repository typechecks, app lint, the style contract, iOS bundle export and the existing browser regression passed after applying the patch. Fresh browser captures were reviewed at phone and narrow-phone sizes, including loading, empty, error, focus and offline states. NativeTabs remains unchanged, but a fresh iOS visual check is pending because the host Mac was locked. The review, patch and validation record are saved locally under `artifacts/inbox-mobile/design/`.

At initial setup, `npm audit` reported five high findings in the Expo CLI dependency chain (`node-forge`, Zod and parent packages). Its proposed Expo downgrade is incompatible with this SDK; no forced downgrade was applied. Review compatible upstream patches before distribution.

The latest conversation/contact refinement was checked in Expo Go on an iPhone 17 Pro simulator running iOS 26.4. The original keyboard gap was reproduced before moving keyboard avoidance to the screen root. Native checks then verified single-line and growing multiline replies, send-and-collapse, interactive keyboard dismissal, contact navigation, and joining through the native action sheet. Sheet content now uses RNHostView so React Native buttons receive touches in the presented native window. Browser regression also covers contact load failure/retry, cached offline reload, draft preservation and narrow layouts. This refinement is included in TestFlight build **1.0.0 (8)**.
