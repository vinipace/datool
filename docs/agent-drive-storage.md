# Agent drive storage

Compute and persistent storage are configured separately. Existing drives keep
both their IDs and contents; migration 0088 adds storage metadata and does not
move or replace any volume.

| Drive storage | Sandbox compute | Durable files |
| --- | --- | --- |
| Local volume | Local container (Docker) | Named volume on the configured Docker daemon |
| Datool volume | Datool Sandbox | Managed Modal Volume |
| Modal volume | Organization's Modal sandbox | Modal Volume in that account |
| S3-compatible storage | Docker, Datool, Modal or Boat | Objects in the selected bucket, with version manifests in PostgreSQL |
| Google Cloud Storage | Docker, Datool, Modal or Boat | Objects in the selected bucket, with version manifests in PostgreSQL |

## Self-hosted Docker and local storage

No AWS, Google or Modal credentials are required. Make Docker available to the
Datool web and Eve workers, configure **Local container** in Organization settings →
Sandbox providers, and choose it in the agent's Sandbox settings. Pre-pull
`node:22-bookworm-slim` and `python:3.13-slim`. Add a drive with **Local volume**
storage. All workers accessing that drive must use the same Docker daemon.

Volumes are named `datool-drive-<project-and-drive-hash>`, with `datool.project`
and `datool.drive` labels. Inspect a specific volume using `docker volume inspect`.
Its mountpoint belongs to the Docker host (or Docker's VM on macOS), not the web
process's checkout. PostgreSQL contains the catalog, ownership and leases; the
volume contains the bytes. Unmounting an agent does not delete its volume.

Back up PostgreSQL and the named volumes with the sandbox stopped. Restore the
same named volumes on the destination daemon before restarting workers. A missing
previously provisioned native volume is an error, never an automatic empty reset.
Local volumes support ordinary filesystem semantics, including installed
dependencies and symlinks. The cloud snapshot limits below do not apply to them.

## Bucket-backed drives

An owner or admin adds a connection in **Organization settings → Storage providers**.
Choose S3-compatible storage (AWS S3 or a compatible endpoint), or GCS. Provide an
existing bucket and prefix, then verify and save. Datool verifies object creation
and reading, and attempts to remove its probe. It does not create buckets or
change bucket access policies.

Storage connections are shared by all projects in the organization. Migration
`0090` preserves connection IDs, credentials, bucket paths and existing drive
references. Drives, manifests, versions and file access remain project-scoped;
sharing a bucket connection does not grant access to another project's drives.
Deleting the original project keeps its organization-owned connection. A
connection used by any drive in the organization cannot be removed.

S3 takes region, access key ID, secret access key, optional session token, and an
optional endpoint. GCS takes the Google project, service-account email and PEM
private key. Give the identity access only to its intended prefix. Keys are
encrypted using `DATOOL_PROVIDER_ENCRYPTION_KEY` (or the existing authentication
secret fallback), bound to both organization and connection, and never sent to the
agent sandbox. Keep the encryption key with your database backup. Editing a
connection rotates credentials or its label; moving buckets requires a new
connection so existing drives cannot silently point at empty storage.

Custom S3 endpoints must resolve to public addresses and use HTTPS by default.
For a trusted self-hosted installation that needs an internal S3 service, set
`DATOOL_STORAGE_ALLOW_PRIVATE_ENDPOINTS=true` on every Datool/Eve worker. This is
an installation-wide opt-in that allows organization admins' storage endpoints to
reach the server's private network; enable it only where those admins are trusted.
It also permits HTTP for internal endpoints.

Select the connection when adding a drive. **SDK workspace storage** in the
agent's Sandbox settings chooses storage for new React SDK workspaces. Cloud
workspace IDs do not depend on compute. An existing workspace cannot be rebound
by changing settings: it fails explicitly instead of creating a second empty
drive. Existing local and Modal workspace IDs remain unchanged.

### Files, synchronization and recovery

The SDK file API reads and writes cloud objects directly, without allocating a
sandbox. Its existing 256 KiB file and 500-entry directory limits still apply.
Each mutation creates a committed version.

Agent commands use a real native working volume, hydrated from the committed
snapshot before execution. Once the sandbox has stopped, Datool checkpoints the
files back to object storage. A turn is not reported as successful until shutdown
and checkpointing succeed. Network access inside the sandbox can remain disabled;
the trusted server performs transfers without exposing bucket credentials.

Snapshots accept regular files and directories, at most 16 MiB per file, 64 MiB
total and 10,000 entries. Keep `node_modules`, virtual environments and symlinks
on a native volume mounted separately. Permissions retain ordinary mode bits,
not ownership, ACLs, hard links or special files. The archive limit is 80 MiB.
This first implementation transfers a bounded snapshot; it is not a live bucket
mount or an unlimited filesystem.

A durable write lease serializes SDK edits and sandbox writers. A failed
checkpoint retains the old committed version and marks the native cache as
pending; further writes cannot hydrate over it. After the sandbox lease expires,
**Recover pending files** retries checkpointing with a new ownership token.
Starting another sandbox also attempts this recovery. If synchronization failed
because of an oversized file or unsupported link, an operator must first fix or
copy those files from the stopped native cache. A missing pending cache fails
closed; Datool never replaces it with an empty snapshot. An interrupted initial
hydration is discarded and retried from the committed version.

### Versions, backups and moving data

The drive's **Versions** panel lists the last 100 commits. Restore creates a new
head and retains prior history; a concurrent change rejects a stale restore.
Export downloads a tar archive of committed files. Import replaces the current
files after archive/path validation and requires the current revision. Use export
and import to copy files to a newly created drive on another connection, then
update static agent mounts. In-place migration of an existing SDK workspace is
not included; it must keep its original connection.

Snapshot manifests and the current revision live in PostgreSQL. File bytes use
SHA-256 keys under `<prefix>/projects/<project-hash>/drives/<drive-id>/objects/`.
Back up **both** the database and bucket objects, as well as the encryption key.
A tar export is a portable file backup, not a backup of version history. Objects
and versions are retained indefinitely in this release; there is no automatic
garbage collection. Do not apply object-expiration rules to live drive prefixes.
Bucket versioning and provider backups can add protection against external deletes.

## API and verification

`build_create_drive` accepts provider `local`, `datool`, `modal`, `s3` or `gcs`.
For S3/GCS, supply `storageConnectionId` from `build_list_storage_connections`.
`build_list_drive_versions`, `build_restore_drive_version` and
`build_recover_drive` operate within the authenticated project. Connection
credential management uses the owner/admin-only organization settings API.

`GET /api/projects/{projectId}/drives/{driveId}/archive` exports a cloud drive;
optional `?revision=<id>` exports a particular version. An owner/admin can `PUT`
an uncompressed tar body with `If-Match: <current-revision>` (or `empty` for a new
drive). These project routes use the web session and trusted-origin checks.

Run migrations before deploying this code. The integration tests require Docker
and a disposable PostgreSQL database. They use pinned S3 and GCS protocol
emulators and real Docker filesystems; they do not validate live cloud IAM.

```sh
DATOOL_TEST_DATABASE_URL=<disposable-loopback-postgres-url> bun --no-env-file test tests/build-drive-storage.test.ts
```
