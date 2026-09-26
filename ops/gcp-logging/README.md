# Datool logs in Google Cloud

This directory provides an optional collector for a Debian 13 AMD64 Dokku host.
It forwards operational logs, not customer traces or application database rows.
Keep project IDs, service-account identities, host inventories, key identifiers,
installation dates, and recovery instructions in a private operator runbook.

## Find production logs

Open [Google Cloud Logs Explorer](https://console.cloud.google.com/logs/query)
and select the project recorded in your private runbook. Use an existing Google
identity authorized to read logs. The collector service account needs only Logs
Writer; its private key is not a reader credential.

Select the incident time window and substitute your collector's resource labels:

```text
resource.type="generic_node"
resource.labels.node_id="YOUR_NODE_ID"
resource.labels.namespace="YOUR_NAMESPACE"
```

| Source | Additional filter |
| --- | --- |
| All Datool containers | `logName="projects/YOUR_GCP_PROJECT_ID/logs/datool.container"` |
| Web | `labels.container="datool.web.1"` |
| Ingestion worker | `labels.container="datool.worker.1"` |
| PostgreSQL | `labels.container="dokku.postgres.datool-db"` |
| Redis | `labels.container="dokku.redis.datool-redis"` |
| Nginx access/errors | `logName="projects/YOUR_GCP_PROJECT_ID/logs/datool.nginx"` |
| Selected host services/kernel | `logName="projects/YOUR_GCP_PROJECT_ID/logs/datool.host"` |
| A particular host unit | `labels.unit="datool-logging.service"` |

Messages are in `jsonPayload.message`. Container `stderr` and nginx error-file
entries are assigned `ERROR`; inspect their messages before classifying an
incident. Compare event `timestamp` with `receiveTimestamp` to detect delays.
Check the installation's forwarding start time and freshness before interpreting
missing records. Collection is not a complete historical archive.

## Configure a private installation copy

Copy this directory outside the source checkout before configuring it. Replace
all `YOUR_` placeholders in that private copy of `fluent-bit.conf`:

- `YOUR_GCP_PROJECT_ID`: the destination Google Cloud project.
- `YOUR_LOCATION`: the host's resource location.
- `YOUR_NAMESPACE`: the installation namespace.
- `YOUR_NODE_ID`: an identifier for this host.

Create a dedicated service account in the destination project, enable the Cloud
Logging API, and grant only `roles/logging.logWriter`. Record the exact expected
service-account email privately. For this non-GCE installation, store its JSON
key privately and transfer it through an authorized channel. Never commit or
print the key or a configured installation copy.

The supplied discovery helper selects Datool web/worker containers and the
`dokku.postgres.datool-db` and `dokku.redis.datool-redis` services. Adapt those
selectors and the nginx paths in your private copy if your service names differ.
Discovery reads container names, IDs and log paths, never container environments.

The Lua filter removes query strings, URL credentials, bearer values and common
credential forms. This is best-effort redaction; application logs must still
avoid secrets and customer payloads.

## Install

The host needs Debian 13 AMD64, Python 3, curl, Docker, systemd and root access.
The installer pins Fluent Bit 4.2.8 and verifies its archive checksum. It refuses
unconfigured placeholders, a different credential project or service-account
identity, and an existing collector installation. It does not restart application
services.

From the configured private copy, supply the key and expected identity:

```sh
sudo bash install.sh /absolute/path/to/logging-service-account.json \
  'YOUR_SERVICE_ACCOUNT@YOUR_GCP_PROJECT_ID.iam.gserviceaccount.com'
```

The key is installed root-only at `/etc/datool-logging/credentials.json` with mode
`0400`. Remove temporary staging copies after verifying the installed copy.
Only the discovery helper accesses Docker; Fluent Bit reads selected files and
the journal without a listening port. It is limited to 256 MiB RAM and 25% of one
CPU, with a 256 MiB persistent buffer that discards the oldest queued data when
full. Cursors survive collector restarts.

Container files are read from their beginning at first discovery. Host and nginx
collection begin with new entries. Log retention, routing, and external alerts
must be configured separately for your project.

## Verify delivery

Use a unique canary and a request to your own configured origin:

```sh
logger -t datool-logging-canary "datool-logging-check $(date -u +%Y%m%dT%H%M%SZ)"
curl --fail "$DATOOL_URL/sign-in" --output /dev/null
```

Confirm fresh canary, nginx, and container records in Logs Explorer, with the
expected resource labels. After a collector restart, verify new delivery again.
Service state alone does not prove delivery or gap-free cursor recovery. Keep
installation-specific evidence and raw records in private operational storage.

Local validation:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -p 'gcp_logging_test.py'
python3 ops/gcp-logging/test-collector.py
```
