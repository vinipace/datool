mock_provider "google" {}

variables {
  project_id            = "example-project"
  node_id               = "example-node"
  namespace             = "example-production"
  location              = "example-location"
  notification_channels = ["projects/example-project/notificationChannels/123"]
}

run "safe_rollout_and_recovery_contract" {
  command = plan

  assert {
    condition     = alltrue([for policy in google_monitoring_alert_policy.state : !policy.enabled]) && !google_monitoring_alert_policy.heartbeat.enabled && !google_monitoring_alert_policy.new_failure.enabled
    error_message = "Policies must stay disabled until an operator verifies fresh matching metric series."
  }

  assert {
    condition = alltrue([for metric in google_logging_metric.state :
      length(metric.metric_descriptor[0].labels) == 0 &&
      strcontains(metric.filter, "resource.labels.location=\"example-location\"") &&
      strcontains(metric.filter, "resource.labels.node_id=\"example-node\"")
    ])
    error_message = "State series must use the configured host identity and no per-job or reason labels."
  }

  assert {
    condition = alltrue([for key, metric in google_logging_metric.state :
      regex(jsondecode(regex("^REGEXP_EXTRACT\\(jsonPayload.message, (.*)\\)$", metric.value_extractor)[0]), jsonencode({ (local.states[key].field) = 0 }))[0] == "0" &&
      regex(jsondecode(regex("^REGEXP_EXTRACT\\(jsonPayload.message, (.*)\\)$", metric.value_extractor)[0]), jsonencode({ (local.states[key].field) = 1 }))[0] == "1"
    ])
    error_message = "Extractors must accept explicit healthy zeros as well as active ones so recovery can be observed."
  }

  assert {
    condition = alltrue([for key, policy in google_monitoring_alert_policy.state :
      policy.conditions[0].condition_threshold[0].evaluation_missing_data == (key == "unavailable" ? "EVALUATION_MISSING_DATA_ACTIVE" : "EVALUATION_MISSING_DATA_NO_OP") &&
      policy.conditions[0].condition_threshold[0].duration != "0s"
    ])
    error_message = "Absent health readings must not resolve an unresolved state incident."
  }

  assert {
    condition     = strcontains(google_monitoring_alert_policy.heartbeat.conditions[0].condition_absent[0].filter, local.resource_filter)
    error_message = "Heartbeat and state alerts must monitor the same resource identity."
  }
}

run "enable_after_verification" {
  command = plan
  variables { enabled = true }
  assert {
    condition     = alltrue([for policy in google_monitoring_alert_policy.state : policy.enabled]) && google_monitoring_alert_policy.heartbeat.enabled && google_monitoring_alert_policy.new_failure.enabled
    error_message = "Verified rollout must enable all five policies together."
  }
}
