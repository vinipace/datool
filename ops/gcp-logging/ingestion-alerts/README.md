# Ingestion alert policies

This Terraform module replaces per-log warning incidents with five metric-based
policies: new failures, unresolved failures, availability, capacity and heartbeat
absence. It uses the existing collector's `jsonPayload.message` JSON string;
no collector replacement or privileged application endpoint is needed.

Configure installation values in a private working copy outside this repository:
`project_id`, `node_id`, `namespace`, **`location`**, and existing
`notification_channels` resource names. All filters use the same exact resource
identity. Keep state, variable files, plans and credentials private. Authenticate
with the operator's existing Google identity, never the collector writer key.

## Rollout

1. In the private copy, run `terraform init`, `terraform plan`, then apply with
   the default `enabled=false`. This creates the metrics before the application
   rollout. Do not disable existing policies yet. Metrics do not backfill logs.
2. Deploy the application change. Set `DATOOL_RELEASE` to the deployed Git SHA
   (or supply the existing `GIT_REV`/`SOURCE_VERSION`). Without it, records contain
   `release:null`, which explicitly indicates unknown provenance.
3. Verify fresh `ingestion_health` samples and the matching metric series. Both
   zero and one must be extracted for `retainedFailureState`, `unavailableState`
   and `capacityWarningState`. A failed health read emits `unavailableState:1`
   and **omits** unobserved queue/capacity values; it must not manufacture zeros.
4. Plan/apply `enabled=true`. Observe the new policies before disabling the old
   combined warning, availability and heartbeat policies. Record their IDs and
   configuration in the private runbook so rollback is possible. Do not leave
   the old per-log policy enabled alongside the replacement indefinitely.
5. Verify the existing notification channel receives the intended open/close
   notifications with a controlled test installation and fresh production
   evidence. A PR or Terraform validation does not prove notification delivery.

Roll back by re-enabling the recorded legacy policies before disabling these.
Keep existing unresolved jobs until they have been diagnosed and reconciled.

## Lifecycle and recovery

- Repeated health samples with retained jobs keep one metric incident open for
  the resource. They no longer emit `FAILED_EVENTS_RETAINED` warnings. Changing
  job counts or diagnostic fingerprints does not create another metric series.
- New-failure activity is counted on attempt one, not every retry. An explicit
  operator replay starts a new processing run and can produce another event.
  Terminal failures remain visible through the unresolved-failures policy.
- State policies evaluate 0/1 distributions over five minutes with a two-minute
  retest. Explicit buckets `[-0.5, 0.5, 1.5]` keep healthy p99 below 0.5 and
  unhealthy p99 above it. No customer/project/job labels are extracted.
- Missing availability samples are treated as active conditions. Missing backlog
  or capacity samples preserve their previous condition (they cannot prove new
  failures or recovery); a separate heartbeat policy detects missing health
  logs. Google still eventually auto-closes stale
  incidents (configured to seven days, plus its missing-data handling). A CLOSED
  notification after missing data is not evidence of recovery.
- Recovery requires fresh zero-valued state samples after the rolling window,
  a fresh heartbeat and a new SDK event with a committed PostgreSQL receipt.
  A zero failed-job count can also result from deletion; reconcile the original
  jobs before declaring their data recovered.

Before enabling, exercise: a permanent failure retained across more than 20
health ticks; another new failure while the backlog incident remains open;
successful retry with committed receipt; loss of health samples; and renewed
healthy samples. Check GCP's actual incident history, not only local outputs.

See Google's [metric alert behavior](https://docs.cloud.google.com/monitoring/alerts/concepts-indepth)
and [distribution log metrics](https://docs.cloud.google.com/logging/docs/logs-based-metrics/distribution-metrics).
