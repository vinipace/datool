# Datool disk maintenance

Install this directory on the Dokku host before deploying the workflow that uses
`disk:load-image`. Run `sudo bash install.sh` from the copied directory. Installation
is idempotent, preserves the retention ledger, and enables an hourly systemd timer.
It also installs the daily 512 MB build-cache override.

The app may be empty at installation. An empty source is accepted only when
Dokku reports no deployment and there is no retention history, app container,
or `dokku/datool:*` image. In this state, cleanup only bounds build cache and
preserves all preloaded source images; status reports `current_image: null`.
The first `disk:load-image` still requires capacity checks and records the
release only after Dokku succeeds. Missing source metadata on an existing
installation fails closed.

The deployment command is:

```sh
dokku disk:load-image datool datool-release:COMMIT-RUN-ATTEMPT IMAGE_SIZE_BYTES < image.tar.gz
dokku disk:status datool
```

The CircleCI build records `docker image inspect --format '{{.Size}}'` in the
checksummed artifact. Before importing, the host requires the larger of 6 GiB or
twice that image size plus 2 GiB on both the Docker and containerd filesystems.
Insufficient capacity fails before `docker load`, with a readable CI error.
Each import supplies a unique temporary context marker to Dokku, so retrying the
same verified image runs a full release rather than failing as an unchanged Git
context. The generated Dockerfile still wraps only the imported image; no Datool
application compilation occurs. The temporary context is removed on success or failure.

A filesystem lock serializes the complete import/release and cleanup, including
hourly cleanup. All Datool imports must use this wrapper. Do not run raw
`git:load-image` concurrently with maintenance. Cleanup only removes validated
`datool-release:COMMIT-RUN-ATTEMPT` tags, without force. It preserves the current
Dokku source, the latest two successful source images, every alias of those images,
and images referenced by any running or stopped container. It never prunes volumes,
databases, persistent directories, or other applications' images. Invalid current
source or ledger state fails closed. "Successful" means Dokku's release and
container checks completed; the workflow additionally checks public endpoints.

After retiring image tags, cleanup also bounds the host's unused BuildKit cache
to 512 MB, setting both `--reserved-space` and `--max-used-space` without an age
filter. Dokku's image-label builds can retain old image
layers in this cache even after their source tags are removed. This runs before
and after deployments and during hourly maintenance, so several releases in one
day cannot accumulate a day's worth of obsolete cache. Docker preserves layers
needed by retained images, containers, and active builds. Other apps may need to
rebuild evicted cache on their next build; their images and data are preserved.

State is stored in `/var/lib/dokku/data/datool-disk-maintenance`. Root owns the
installed code; the Dokku account owns the lock and atomically written ledger.
Inspect the timer with `systemctl status datool-disk-maintenance.timer` and its
history with `journalctl -u datool-disk-maintenance.service`.

`disk:status` is read-only and exits nonzero below 6 GiB available. CircleCI
checks this every six hours and supports manual runs.
CircleCI failure notifications depend on project/account notification settings.
The timer also fails visibly below this threshold. Neither mechanism deletes
application data when growth requires operator attention.

## Restricted external monitoring

`install-monitor.sh PUBLIC_KEY_FILE` installs a separate `datool-monitor` account
using one plain Ed25519 public key. Run it as root after `install.sh`. It replaces
that account's monitoring key, so use the same key on repeat installations or
coordinate key rotation with the workflow secrets.

The key has an SSH forced command and `restrict` options. Only the exact command
`disk:status datool` is accepted. The account has no Docker/sudo group membership
and no writable home or authorized-keys file. Its single sudo rule runs the
root-owned Python status script as `dokku`, with Python isolated mode. It cannot
invoke cleanup, load images, open a shell, or forward ports. The status check
reads Docker/Dokku state and writes only the maintenance lock file.

The `scheduled-disk-health` workflow in `.circleci/config.yml` checks the configured host at
00:17, 06:17, 12:17 and 18:17 UTC. For a manual check, run a main pipeline with
`operation=disk-health`. Store `NETCUP_MONITOR_SSH_PRIVATE_KEY` and
`NETCUP_MONITOR_SSH_KNOWN_HOSTS`, and `DOKKU_SSH_HOST` in the project/main-restricted `datool-monitor`
context. Verify the host-key fingerprint through a trusted channel before storing
known_hosts. Configure CircleCI failure notifications; there is no separate paging
integration. See [CI activation](../../docs/ci.md#activation-and-credentials).

The Dockerfile removes `.next/cache` in the build stage before copying output into
the runtime image. Production-image acceptance rejects shipped Turbopack/Webpack
caches and exercises rendered content, migrations, worker ingestion, and APIs.

## Host logging and build-cache policy

Configure `/etc/docker/daemon.json` with bounded `json-file` rotation, for
example `max-size=10m` and `max-file=3`. Preserve any existing `live-restore`
setting. Docker defaults apply to newly created containers; inspect existing
containers separately. Keep bounded journald storage as well. Optional remote
forwarding is described in the [logging guide](../gcp-logging/README.md).

The daily `docker-builder-prune.service` is overridden to prune unused
build cache older than 24 hours with a 512 MB cache target. Active/in-use cache
can exceed that target. It does not prune application images or volumes. Keep
server builds disabled in Datool CI; the verified image is built in CircleCI.

Validate changes locally with:

```sh
python3 -m unittest discover -s tests -p 'dokku_disk_test.py'
bun test tests/deployment-image-handoff.test.ts
```
