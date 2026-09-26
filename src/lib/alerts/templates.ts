import { defaultAlertConfig, type AlertConfig } from "./contracts"

export const alertTemplates: {
  id: string
  label: string
  description: string
  config: AlertConfig
}[] = [
  {
    id: "request-failures",
    label: "Request failures",
    description: "Notify when a request finishes with an error.",
    config: {
      ...defaultAlertConfig,
      name: "Request failures",
      filter: "resource = 'trace' AND status = 'errored'",
      notifyIntervalSeconds: 300,
    },
  },
  {
    id: "error-burst",
    label: "Error burst",
    description: "10 or more failed requests within 5 minutes.",
    config: {
      ...defaultAlertConfig,
      name: "Error burst",
      type: "time_window",
      filter: "resource = 'trace' AND status = 'errored'",
      threshold: 10,
      windowSeconds: 300,
      notifyIntervalSeconds: 300,
    },
  },
  {
    id: "slow-llm",
    label: "Slow LLM calls",
    description: "An LLM call takes longer than 5 seconds.",
    config: {
      ...defaultAlertConfig,
      name: "Slow LLM calls",
      filter: "resource = 'span' AND kind = 'llm' AND duration_ms > 5000",
      notifyIntervalSeconds: 300,
    },
  },
  {
    id: "expensive-requests",
    label: "Expensive requests",
    description: "A request's recorded cost exceeds $0.50.",
    config: {
      ...defaultAlertConfig,
      name: "Expensive requests",
      filter: "resource = 'trace' AND cost_usd > 0.5",
      notifyIntervalSeconds: 300,
    },
  },
  {
    id: "guardrail-failures",
    label: "Guardrail failures",
    description: "Requires the boolean log attribute guardrail_failed.",
    config: {
      ...defaultAlertConfig,
      name: "Guardrail failures",
      description:
        "Log guardrail_failed=true in trace or span attributes when a guardrail fails.",
      filter: "span_attributes.guardrail_failed = true",
      notifyIntervalSeconds: 300,
    },
  },
  {
    id: "fallbacks",
    label: "Model fallbacks",
    description: "Requires the boolean log attribute fallback_used.",
    config: {
      ...defaultAlertConfig,
      name: "Model fallbacks",
      description:
        "Log fallback_used=true in trace or span attributes when a fallback is used.",
      filter: "span_attributes.fallback_used = true",
      notifyIntervalSeconds: 300,
    },
  },
]

export const alertIntervals = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [3600, "1 hour"],
  [21600, "6 hours"],
  [86400, "1 day"],
  [604800, "1 week"],
] as const
export const alertWindows = [
  [60, "1 minute"],
  [300, "5 minutes"],
  [900, "15 minutes"],
  [3600, "1 hour"],
  [86400, "24 hours"],
] as const
export const alertIntervalLabel = (seconds: number) =>
  alertIntervals.find(([value]) => value === seconds)?.[1] ??
  `${seconds} seconds`
