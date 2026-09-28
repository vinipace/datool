# Organization members and invitations

Open **Members** from the account menu or a project's settings. Organization settings has a sidebar linking Members and Billing. Search the members table by name, email, or role; **Invite member** opens the invitation form, and **Pending invitations** opens a table in a right-side panel. Each pending invitation has a **Copy link** action and a menu to resend or cancel it. Members belong to an organization and can access its projects. Owners and admins can invite teammates as members or admins, resend or cancel pending invitations, change non-owner roles, and remove other non-owner members. Ordinary members see the member list without management controls. The UI never offers owner removal, ownership transfer, or self-demotion; Better Auth also protects the last owner on the API.

## Installation

1. Apply the normal database migrations, including `0038_invitation_email.sql`.
2. Verify a sending domain in Resend and create a sending-only API key.
3. Configure the server environment:

```dotenv
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=Datool <invites@your-verified-domain.com>
BETTER_AUTH_URL=https://your-datool-host.example
```

Set Google OAuth's authorized redirect URI to `${BETTER_AUTH_URL}/api/auth/callback/google`. Restart the app after changing environment variables. Secrets must remain outside Git. Invitations work independently of `DATOOL_BILLING_ENABLED`; joining an organization does not create a second subscription. Missing Resend configuration disables the invite UI and returns a clear error from the mutation API.

## Acceptance and access

The email links to `/invite/<invitationId>`. Opening the link does not accept it. A signed-out visitor signs in with Google and returns to the invitation; the matching verified email must explicitly accept or decline. Wrong-account visitors can sign out and switch accounts. Links expire after 48 hours. Canceled, declined, expired, or accepted invitations cannot be accepted again. Expired invitations can be replaced with a fresh link from the resend action.

An explicit invitation permits its matching verified Google recipient to sign in even when `AUTH_ALLOWED_DOMAINS` otherwise excludes their domain. A pending invitation requires the inviter to remain an organization member. After acceptance, the recipient must remain a member to retain that sign-in exception. This does not grant access to other organizations. Removing a member revokes organization access even if an existing session remains valid.

## Email delivery and retries

The app awaits Resend acceptance and durably records its message ID. **Email sent** means Resend accepted the message, not that a person's inbox received it. Delivery, bounces, and spam placement must be checked in Resend; delivery webhooks are not installed by this feature.

Better Auth catches email-hook exceptions, so a post-operation hook checks the durable delivery record and returns an actionable failure if sending was not confirmed. A failed email leaves the pending invitation visible for retry. Retries of uncertain attempts reuse the same persisted payload and idempotency key for up to 23 hours, within Resend's 24-hour window. Concurrent sends for one invitation are serialized. Confirmed sends have a one-minute resend cooldown. An explicit resend after that cooldown starts a new attempt and refreshes the invitation expiration.

For an unexpired invitation, **Copy link** copies the current installation's `/invite/<invitationId>` URL without sending another email. It works when email delivery is unconfirmed or the sender is no longer configured. If clipboard access fails, the panel exposes a selected, read-only link for manual copying. Share it with the invited recipient; the matching verified email and explicit acceptance are still required. Expired links cannot be copied: resend first, then copy the refreshed invitation.

If sender configuration changes while retrying a failed attempt, cancel that invitation and create a new one so the new payload uses the updated sender. Old payloads intentionally remain unchanged for provider idempotency.

## Verification

Run the integration suite against a disposable loopback PostgreSQL database:

```sh
DATOOL_TEST_DATABASE_URL=postgresql://datool:datool@127.0.0.1:19433/datool \
  bun test tests/invitations.test.ts tests/organization-auth.test.ts tests/launch-access.test.ts
bunx vitest run --project=storybook \
  components/workspace/members-page.stories.tsx \
  components/workspace/invitation-page.stories.tsx
bun run check:pre-push
```

The integration suite exercises real database persistence and Better Auth handlers: anonymous and cross-organization denial, unprivileged mutations, origin protection, wrong or unverified recipients, fresh invited Google callback persistence (external token exchange mocked), acceptance, decline, cancellation, expiration, removed inviters, role changes, member removal, last-owner protection, provider failures, stable retry payloads, and resend cooldown. The UI stories cover loading, empty invitations, errors and retry, sender configuration, read-only members, confirmation dialogs, sign-in, account mismatch, acceptance failure, and decline.

### Browser and provider evidence, 22 September 2026

An isolated local workspace was tested through Chrome at port 3007. The Members form sent through the real Resend API using `onboarding@resend.dev` and a unique `delivered+datool-…@resend.dev` test recipient. Resend displayed its simulated **Delivered** event and the correct invitation link. The same link rejected the owner's wrong account, displayed the recipient's acceptance screen, and after acceptance opened the existing project. The new member appeared in the persisted member list without management controls. The owner then changed that member to admin through the confirmation dialog. Desktop and 390px mobile screenshots were captured.

This provider test used signed sessions for disposable fixture identities. It proves the application and provider path, but does not prove real Google browser sign-in or real inbox receipt. Completing that final check requires the configured Google client's localhost redirect URI, a verified sending domain, and a chosen real recipient. Resend's test address deliberately simulates delivery and is not a human inbox.

See [Resend test recipients](https://resend.com/docs/dashboard/emails/send-test-emails), [Resend idempotency](https://resend.com/docs/dashboard/emails/idempotency-keys), and [Better Auth organization invitations](https://better-auth.com/docs/plugins/organization).
