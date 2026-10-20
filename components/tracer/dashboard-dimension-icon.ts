import { Bot, Box, Layers, MessageCircle, Workflow } from "lucide-react"
import type { SemanticDataRow } from "@/src/lib/semantic/result"
import type { ChannelId } from "@/src/lib/build/channels"
import { channelCatalog } from "@/components/build/shared/channel-catalog"

export function dashboardChannelId(
  dimension: string,
  value: unknown
): ChannelId | undefined {
  if (
    [
      "buildEvents.channel",
      "buildTickets.channel",
      "buildCsat.channel",
    ].includes(dimension) &&
    typeof value === "string" &&
    Object.hasOwn(channelCatalog, value)
  )
    return value as ChannelId
}

export function dashboardGroupText(dimensions: string[], row: SemanticDataRow) {
  return dimensions
    .map((dimension) => dashboardDimensionText(dimension, row[dimension]))
    .join(" · ")
}

export function dashboardDimensionText(dimension: string, value: unknown) {
  const channel = dashboardChannelId(dimension, value)
  if (channel)
    return channel === "web" ? "Website" : channelCatalog[channel].label
  if (value !== null && value !== undefined) return String(value)
  return [
    "logs.agentName",
    "logs.workflowName",
    "logs.functionName",
    "logs.stepName",
    "agents.name",
    "workflows.name",
  ].includes(dimension)
    ? "Unattributed"
    : "Not recorded"
}

export function dashboardDimensionIcon(dimension: string) {
  if (["logs.agentName", "agents.name"].includes(dimension)) return Bot
  if (["logs.workflowName", "workflows.name"].includes(dimension))
    return Workflow
  if (dimension === "logs.functionName") return MessageCircle
  if (dimension === "logs.stepName") return Box
  if (
    [
      "logs.traceName",
      "logs.trace",
      "traces.traceName",
      "traces.trace",
    ].includes(dimension)
  )
    return Layers
  return undefined
}
