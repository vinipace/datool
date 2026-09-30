terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 7.0"
    }
  }
}

variable "project_id" { type = string }
variable "node_id" { type = string }
variable "namespace" { type = string }
variable "location" { type = string }
variable "notification_channels" { type = list(string) }
variable "enabled" {
  type        = bool
  default     = false
  description = "Enable only after verifying fresh version-2 health samples and metric series."
}

provider "google" { project = var.project_id }

locals {
  # Use identical resource identity for logs, thresholds and heartbeat absence.
  resource_filter = "resource.type=\"generic_node\" AND resource.labels.node_id=${jsonencode(var.node_id)} AND resource.labels.namespace=${jsonencode(var.namespace)} AND resource.labels.location=${jsonencode(var.location)}"
  log_filter      = "${local.resource_filter} AND logName=\"projects/${var.project_id}/logs/datool.container\" AND labels.container=\"datool.worker.1\""
  states = {
    retained = {
      field       = "retainedFailureState"
      title       = "Datool unresolved ingestion failures"
      instruction = "One or more events remain failed. Inspect their jobs and PostgreSQL receipts. New traffic can still be healthy. Recovery requires a fresh zero-valued sample after deliberate resolution of the failed jobs."
    }
    unavailable = {
      field       = "unavailableState"
      title       = "Datool ingestion availability"
      instruction = "The worker reports unavailable Redis, unsafe persistence, critical capacity, or accepted work without progress. Inspect ingestion_health reasons and ingestion_worker_error diagnostics. Verify a persisted canary after recovery."
    }
    capacity = {
      field       = "capacityWarningState"
      title       = "Datool ingestion capacity warning"
      instruction = "Redis memory is high or its limit is unset. Retained failed events have a separate policy. Inspect the latest health sample before changing capacity."
    }
  }
  recovery_note = "Missing data is not recovery. Missing samples preserve the last observed backlog/capacity condition and trigger availability/heartbeat alerts. Google can still auto-close stale incidents after its timeout, so CLOSED alone is not proof of recovery. Inspect fresh logs and a committed receipt."
}

# Logs-based numeric metrics are DELTA distributions, not GAUGE metrics. Explicit
# buckets straddle 0 and 1; p99 of healthy samples stays below the 0.5 threshold.
resource "google_logging_metric" "state" {
  for_each    = local.states
  project     = var.project_id
  name        = "datool_ingestion_v2_${each.key}"
  description = each.value.title
  filter      = "${local.log_filter} AND jsonPayload.message:\"\\\"event\\\":\\\"ingestion_health\\\"\" AND jsonPayload.message:\"\\\"${each.value.field}\\\":\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "1"
  }
  value_extractor = "REGEXP_EXTRACT(jsonPayload.message, \"\\\"${each.value.field}\\\":([01])\")"
  bucket_options {
    explicit_buckets { bounds = [-0.5, 0.5, 1.5] }
  }
}

resource "google_logging_metric" "heartbeat" {
  project = var.project_id
  name    = "datool_ingestion_v2_heartbeat"
  filter  = "${local.log_filter} AND jsonPayload.message:\"\\\"event\\\":\\\"ingestion_health\\\"\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "new_failure" {
  project = var.project_id
  name    = "datool_ingestion_v2_new_failure"
  # First failure of each processing run, whether permanent or retryable. Match
  # the full numeric field so attempts 10/100 do not count as first attempts.
  filter = "${local.log_filter} AND jsonPayload.message:\"\\\"event\\\":\\\"ingestion_failed\\\"\" AND jsonPayload.message =~ \"\\\"attemptsMade\\\":1[,}]\""
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_monitoring_alert_policy" "state" {
  for_each              = local.states
  project               = var.project_id
  display_name          = each.value.title
  combiner              = "OR"
  enabled               = var.enabled
  notification_channels = var.notification_channels
  user_labels           = { datool_component = "ingestion-v2" }
  documentation {
    mime_type = "text/markdown"
    content   = "${each.value.instruction}\n\n${local.recovery_note}"
  }
  conditions {
    display_name = each.value.title
    condition_threshold {
      filter                  = "${local.resource_filter} AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.state[each.key].name}\""
      comparison              = "COMPARISON_GT"
      threshold_value         = 0.5
      duration                = "120s"
      evaluation_missing_data = each.key == "unavailable" ? "EVALUATION_MISSING_DATA_ACTIVE" : "EVALUATION_MISSING_DATA_NO_OP"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_PERCENTILE_99"
      }
      trigger { count = 1 }
    }
  }
  # No repeated notification strategy and no job/project/reason labels: a stable
  # resource has one open incident for the duration of each unresolved condition.
  alert_strategy { auto_close = "604800s" }
}

resource "google_monitoring_alert_policy" "heartbeat" {
  project               = var.project_id
  display_name          = "Datool ingestion heartbeat missing"
  combiner              = "OR"
  enabled               = var.enabled
  notification_channels = var.notification_channels
  user_labels           = { datool_component = "ingestion-v2" }
  documentation {
    mime_type = "text/markdown"
    content   = "No worker health samples for five minutes. Check the worker and log collector, timestamps and resource labels. ${local.recovery_note}"
  }
  conditions {
    display_name = "No ingestion heartbeat for five minutes"
    condition_absent {
      filter   = "${local.resource_filter} AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.heartbeat.name}\""
      duration = "300s"
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "604800s" }
}

resource "google_monitoring_alert_policy" "new_failure" {
  project               = var.project_id
  display_name          = "Datool new ingestion failures"
  combiner              = "OR"
  enabled               = var.enabled
  notification_channels = var.notification_channels
  user_labels           = { datool_component = "ingestion-v2" }
  documentation {
    mime_type = "text/markdown"
    content   = "An event failed its first processing attempt. Find ingestion_failed logs with projectId, eventId and jobId, then inspect the retained job if it did not recover. Closing this activity alert means no new failures in the window, not that previously failed events were recovered. Consult the unresolved-failures and heartbeat policies."
  }
  conditions {
    display_name = "New failures in the last five minutes"
    condition_threshold {
      filter          = "${local.resource_filter} AND metric.type=\"logging.googleapis.com/user/${google_logging_metric.new_failure.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_SUM"
      }
      trigger { count = 1 }
    }
  }
  alert_strategy { auto_close = "604800s" }
}
