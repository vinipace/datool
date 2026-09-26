const labels: Record<string, string> = {
  queued: "Queued",
  invoking: "Executing app",
  awaiting_delivery: "Awaiting trace delivery",
  capturing: "Capturing evidence",
  scoring: "Scoring",
  completed: "Completed",
  error: "Execution error",
  blocked: "App completion uncertain",
  legacy: "No recorded checkpoint",
}
export const evalStageLabel = (stage: string) => labels[stage] ?? stage
