# Avoid production builds on application hosts

A Next.js build can consume enough memory and swap to interrupt an otherwise
healthy application, database, or worker on the same host. Serializing deployments
does not bound the memory consumed by a single build.

Build and test the production image in CI, then transfer the verified image to
the deployment host. Keep checksum verification, commit/run/attempt tags, release
migrations, process checks, and public HTTP checks in the deployment path.

During an incident, inspect kernel OOM records, memory and swap pressure, running
builds, and container state before restarting services. Canceling a CI workflow
does not prove that its remote processes stopped. Distinguish recovery of the
previous image from successful deployment of a new revision.

Keep host inventories, incident timelines, recovery-console instructions, raw
logs, and deployment identifiers in the operator's private incident records.
See [Deploying with Dokku](../dokku.md) for the reusable deployment procedure.
