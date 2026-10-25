# Encrypted Dokku recovery backups

This is an operator-installed restic runner, separate from the application and
release pipeline. It adds no work to a customer request. It does **not** encrypt
live disks, configure a cloud account, or establish Shopify compliance by itself.

## What it backs up

- Consistent PostgreSQL export through the installed Dokku plugin.
- Redis export through the installed Dokku plugin (queue recovery).
- Dokku application configuration, including the keys needed to decrypt records.
- Explicit persistent file paths, including `/app/.data`'s host mount.

Inventory all linked databases, external CMS storage, object storage, extra mounts,
logs, snapshots, legacy exports, and deployment configuration before adopting the
example. Add every required database as a separate named stream. Keep the release
image and host rebuild procedure independently recoverable; this is a data backup,
not a complete machine image.

Export commands feed restic directly using `--stdin-from-command`. A failed export
cannot silently become an empty successful snapshot. Data is never staged as a
plaintext dump by this runner. Confirm the installed datastore exporters do not
stage plaintext elsewhere; their internal behavior depends on plugin version.
No restic metadata cache is written. Commands run without a shell and their raw
output/errors are not copied into operational logs.

Each run saves component snapshots and, only after all succeed and `restic check`
passes, an encrypted `manifest.json` referencing those exact snapshots. Restore
from a completed manifest, never a mixture of independent `latest` snapshots.
The check validates repository structure; a real restore and `check --read-data`
are still required. Interrupted/partial runs have no completion manifest.

These are **online, individually consistent** snapshots. PostgreSQL, Redis and
files are not captured in one distributed transaction. For a migration cutover,
pause incoming writes and workers, finish the final backup, and reconcile queues
before restarting. During disaster recovery keep outbound email, chat delivery,
Shopify mutations and other external calls disabled until replay safety and
post-backup erasures have been reviewed. Never restore live PostgreSQL data files
from an ordinary file copy.

## Preparation and installation

1. Inspect the target with `inventory.py --app APP --postgres PG_CONTAINER
--redis REDIS_CONTAINER` using sudo. It prints metadata only. Review installed
   `dokku postgres:export`, `redis:export`, and `config:export` behavior. Validate
   each exported format and the necessary restore/import version on an isolated
   host. This audit is not a provider encryption attestation.
2. Choose a private off-host restic repository and approved region/budget. Use
   scoped storage credentials and HTTPS. Keep a separate offline/password-manager
   recovery copy of the restic password and storage account recovery information.
   The only copy must never live on the server being backed up. Confirm storage
   deletion protection and a retention/pruning policy compatible with erasure
   obligations; encryption does not prevent an attacker deleting backups.
3. Install a supported restic version with `--stdin-from-command` (tested version
   is pinned in `Dockerfile.test`) and Python 3. Install `backup.py` as root-owned
   `/opt/datool-backup/backup.py`. Create `/etc/datool-backup` and
   `/var/lib/datool-backup` with mode 0700. Configure `config.json` and
   `restic.env` there, both root-owned mode 0600. Commands in the JSON configuration
   run as root: never allow untrusted users to edit it or its parent directory.
4. In `restic.env`, set `RESTIC_REPOSITORY`, `RESTIC_PASSWORD_FILE` and the backend's
   narrowly scoped credentials. The password file must be root-owned mode 0600.
   Do not put credentials in command arguments, source control or screenshots.
   Load this reviewed environment privately and run `restic init` once. The runner
   deliberately never initializes or replaces a repository on an authentication
   error.
5. Complete a manual backup, isolated restore, and key-recovery exercise first.
   Record database/file/queue sizes, duration, and CPU/I/O/latency before and during
   the backup. The runner limits upload bandwidth; the service limits its own CPU,
   memory and I/O priority. **Exports inside datastore containers do not inherit
   those CPU limits.** Measure database and Redis export impact before scheduling.
6. Install the service/timer in `/etc/systemd/system`. Enable the timer only after
   the restore, performance check, retention and alert delivery are proven.
   The example runs daily at 03:00 UTC with jitter; a successful daily schedule
   still permits approximately 24 hours of lost changes. Set the frequency and
   health age from the accepted recovery objective.

The checked-in example is a starting point, not a production inventory. Installing
these files does not restart the app, alter live volumes, or change billing.

## Monitoring and retention

`python3 /opt/datool-backup/backup.py /etc/datool-backup/config.json --health`
exits nonzero if no successful backup exists, the latest attempt failed or exceeded its two-hour runtime deadline, or success
is older than the configured limit. An active backup does not invalidate a still-fresh
previous recovery set. It prints only a status
and run identifier. Wire both service failure and missed/stale runs into the
installation's existing external monitoring, then deliberately fail a synthetic
job and verify the alert actually arrives. A timer and a journal entry alone do
not establish monitoring.

Retention is deliberately a separate maintenance operation. Preview any `forget`
policy before pruning, constrain it to this backup's host/tag, and keep complete
manifest/component groups. Do not apply independent count-based retention to each
stream: it can retain a manifest after removing snapshots it needs. A time-based
window retaining **all** snapshots in the window is a simple starting point; retain
at least one complete known-good recovery set beyond the boundary. Validate every
retained manifest's references before deletion. Pruning can contend with backups,
so schedule it separately, then run integrity checks. No deletion is enabled by
these files. Adopt an actual finite policy before treating backup retention as
implemented for Shopify.

## Restore rehearsal

Use an empty, encrypted destination with no route to production or external
services. Select a snapshot tagged `complete`, extract its `manifest.json`, and
verify all referenced component snapshots still exist. Restore the PostgreSQL
dump into an empty database with the matching extensions/major version, validate
records and constraints, load the Redis export into a disposable Redis instance,
and restore files with `restic restore ... --verify`. Treat `application.env` as
secret material. Retain original decryption keys, but replace outbound credentials
before starting any application process in the rehearsal.

Apply erasures recorded after the backup, check ownership/isolation with synthetic
requests, and measure elapsed recovery time. Keep the source fenced during a real
cutover; after new writes, rollback requires reconciliation, not simply starting
the stale database.

## Local test

`bash ops/dokku-backup/test.sh` builds the pinned restic test image and runs actual
PostgreSQL/Redis services on a disposable internal Docker network, with no host
ports or production configuration. It verifies database, queue, file and config
recovery; wrong-key rejection; a real failed database export; stale/failed health;
and protection of the previous successful receipt. It does not verify the installed
production Dokku exporter versions or off-host provider credentials.

References: [restic command streams](https://restic.readthedocs.io/en/stable/040_backup.html#reading-data-from-a-command),
[restic restore](https://restic.readthedocs.io/en/stable/050_restore.html),
[Dokku recovery caveats](https://dokku.com/docs/advanced-usage/backup-recovery/).
