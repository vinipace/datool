# Evolution managed channel

One Dokku app hosts up to three logical WhatsApp instances in the initial pilot.
Each number belongs to one Datool connection. A number does not require a new
container or deployment. Meta remains the default provider for existing channels.

## Release contract

- Evolution 2.3.7, upstream commit `cd800f2976e1e5b682fbf86a01ee4d85ae61f370`.
- Original image `evoapicloud/evolution-api@sha256:1bd8afc4a6cf48822e6cf02469aeae7bd35a12a6b616eacd1291926307f4d339`.
- AMD64 manifest `sha256:456b4104b0ddffbb092d6b3c0560a4ae86fc3e014e885b882aca4b1b371dfc81`.
- License in this tag is Apache-2.0 with upstream attribution provisions. Datool
  attributes Evolution in channel settings and does not reuse its manager UI.
- Unofficial WhatsApp connectivity can result in restrictions even for receptive
  support. The UI records a versioned acknowledgement before pairing.
- Pilot: individual text replies, customer activity within 24 hours, no campaigns,
  groups, templates, history import or media automation. This is a Datool policy;
  it does not grant permission from Meta.

## Bootstrap

Review `bootstrap.sh`, `maintenance.sh`, and `safe-logs.cjs`. Copy them into one
operator-owned staging directory with `../gcp-logging/discover-containers.py`.
Authenticate as root using the operator's secure terminal. Run:

```sh
bash /path/to/reviewed/bootstrap.sh
```

The script checks capacity and existing number conflicts, saves a Datool database
backup, creates separate PostgreSQL 15/Redis 7 services, allocates a 1.5 GiB/1 CPU
Evolution process, and imports the pinned upstream image. It refuses existing
app/service names; inspect partial failures before retrying. It never restarts
Datool. Its private root-only log may contain service credentials; never upload it.

The API has no public proxy or published database/cache ports. The Datool backend
uses `http://datool-evolution.web.internal:8080` over an attached private network.
Network/config changes take effect on Datool's next deployment. The installation
uses one web process and `checks:disable` so upgrades stop the old session owner
before starting another. This deliberately causes downtime on Evolution upgrades.

The image runs as root; only its dedicated session directory and read-only logger
preload are mounted. It gets no Docker socket or host configuration. Verify the
UID and writable directories again when changing the image.

Evolution writes raw message objects directly to `console.log`. `safe-logs.cjs`
suppresses argument rendering; `LOG_BAILEYS=silent` disables the separate protocol
logger. Do not remove this preload or enable debug logs with paired numbers.
The collector update includes only the redacted Evolution web logs. Verify fresh
Cloud Logging records independently after deployment; installation is not proof
of forwarding. Watch worker reconciliation failures and uncertain channel jobs.

## Release Datool and activate a pilot

Publish Datool through the existing CircleCI verified-image workflow. Before the
schema migration, retain the bootstrap's database backup and resolve any Meta
number conflicts. Verify the source image, migrations, web, worker, buildworker,
and private Evolution reachability. In a secure operator shell, enable only the
selected project (these are installation variables, not browser inputs):

```sh
dokku config:set datool DATOOL_EVOLUTION_ENABLED=true DATOOL_EVOLUTION_PROJECT_IDS=PROJECT_ID
```

The command restarts Datool. Coordinate it with releases. Then open the selected
agent's WhatsApp channel, choose Evolution, accept the notice and scan the QR.
QRs are response-only, noncached and hidden after 30 seconds. Pairings abandoned
for 30 minutes are cleaned by the buildworker. Pending disconnects retry there,
even after the pilot is disabled. Pausing preserves incoming Inbox messages and
stops new automated sends. Uncertain sends require reconciliation, never blind retry.

Verify on two authorized phones: new inbound text, one agent response actually
received, human takeover, manual phone echo, pause, logout and relink. Restart the
Evolution container once and confirm the paired session recovers. Do not report
HTTP health or provider acceptance as device delivery. Observe the first pilot
for 48 hours before adding customer numbers.

## Persistence, retention and recovery

PostgreSQL's Session table is authoritative; `CACHE_REDIS_SAVE_INSTANCES=false`.
The dedicated instances volume is retained too. Provider messages are deleted
after three days; older delivery receipt updates are no longer available there.
Datool Inbox history follows Datool's existing retention. Credentials, QR codes
and raw webhook payloads are excluded from Datool operation receipts and audit logs.

`maintenance.sh` creates daily root-only database dumps and a session-volume copy,
retained for seven days locally. Local copies do not cover host loss. Before a
customer rollout, include these paths plus root-protected Dokku configuration in
the operator's encrypted off-host backups and prove a restore. Never put backups
or real execution artifacts in this repository. The local acceptance environment
exercised dump/restore without launching a second Evolution session owner.

For an upgrade: pause admission, record image/config, create a fresh backup, test
the target image against a disposable restore, deploy one owner, then verify health
and paired recovery. Roll back an image only if its schema remains compatible.
Otherwise restore in isolation with Evolution stopped, then start a single owner.
Do not restore a copied authenticated session into a concurrently running instance.

Disable automation with `DATOOL_EVOLUTION_ENABLED=false` on Datool; queued jobs are
also gated. If host resources are pressured, stop only `datool-evolution`. Preserve
its database and volume until all number sessions have been explicitly revoked.
Remove app/services only after session cleanup and the operator's retention decision.

## Verification

`bun run test:evolution:e2e` owns the new provider lifecycle, tenant isolation,
webhook authentication, deduplication, policy and uncertain-send contracts using
PostgreSQL plus a simulated provider. `bun run test:whatsapp:e2e` owns the official
Meta integration. Both require a disposable `DATOOL_TEST_DATABASE_URL`.

The pinned Evolution image was also exercised locally for create, per-instance
credentials, webhook configuration, QR generation and removal. Actual WhatsApp
send/receipt events and restart recovery require the operator's paired test phone.
