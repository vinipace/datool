"use client"

import { createLucideIcon } from "lucide-react"

/** Solid navigation silhouettes with transparent details, readable in either theme. */
function solidIcon(name: string, d: string) {
  return createLucideIcon(name, [
    ["path", { d, fill: "currentColor", fillRule: "evenodd", stroke: "none", key: "solid" }],
  ])
}

export const HomeFilledIcon = solidIcon(
  "house-filled",
  "M2 10a3 3 0 0 1 1.06-2.29l7-6a3 3 0 0 1 3.88 0l7 6A3 3 0 0 1 22 10v9a3 3 0 0 1-3 3h-4v-9H9v9H5a3 3 0 0 1-3-3Z"
)

export const TracesFilledIcon = solidIcon(
  "activity-filled",
  "M8.5 1a1.5 1.5 0 0 1 1.44 1.07L14 15.62l2.06-6.05A1.5 1.5 0 0 1 17.5 8.5H22v3h-3.42l-3.16 9.48a1.5 1.5 0 0 1-2.86-.05L8.5 7.38l-2.06 6.05A1.5 1.5 0 0 1 5 14.5H1v-3h2.92l3.16-9.48A1.5 1.5 0 0 1 8.5 1Z"
)

export const DashboardFilledIcon = solidIcon(
  "layout-dashboard-filled",
  "M4 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM15 2h5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2ZM15 11h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2ZM4 15h5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2Z"
)

export const AgentFilledIcon = solidIcon(
  "bot-filled",
  "M8 3h5v4h5a3 3 0 0 1 3 3v3h2v2h-2v3a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3v-3H1v-2h2v-3a3 3 0 0 1 3-3h5V5H8ZM8 12v4h2v-4ZM14 12v4h2v-4Z"
)

export const WorkflowFilledIcon = solidIcon(
  "workflow-filled",
  "M5 2h4a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3H8v3a1 1 0 0 0 1 1h3v-1a3 3 0 0 1 3-3h4a3 3 0 0 1 3 3v4a3 3 0 0 1-3 3h-4a3 3 0 0 1-3-3v-1H9a3 3 0 0 1-3-3v-3H5a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Z"
)

export const SessionFilledIcon = solidIcon(
  "messages-circle-filled",
  "M9 1a7 7 0 0 1 0 14 7 7 0 0 1-2.6-.5L2 16l1-4.4A7 7 0 0 1 9 1ZM18 8a7 7 0 0 1 3 10l1 4-4-1a7 7 0 0 1-10-4h1a9 9 0 0 0 9-9Z"
)

export const ReportFilledIcon = solidIcon(
  "file-chart-column-filled",
  "M6 1h7v6a2 2 0 0 0 2 2h6v11a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V4a3 3 0 0 1 3-3ZM15 1l6 6h-6ZM7 16v3h2v-3ZM11 11v8h2v-8ZM15 14v5h2v-5Z"
)

export const AlertFilledIcon = solidIcon(
  "bell-filled",
  "M12 1a7 7 0 0 1 7 7c0 4.1 1.2 5.3 2.5 6.6A2 2 0 0 1 20 18H4a2 2 0 0 1-1.5-3.4C3.8 13.3 5 12.1 5 8a7 7 0 0 1 7-7ZM9 20h6a3 3 0 0 1-6 0Z"
)

export const PlayFilledIcon = solidIcon(
  "play-filled",
  "M5 3a2 2 0 0 1 3-1.73l13 9a2 2 0 0 1 0 3.46l-13 9A2 2 0 0 1 5 21Z"
)

export const EvalFilledIcon = solidIcon(
  "flask-conical-filled",
  "M8 1h8v2h-1v5l5.6 10.6A3 3 0 0 1 18 23H6a3 3 0 0 1-2.6-4.4L9 8V3H8ZM11 3v5.5L8.2 14h7.6L13 8.5V3Z"
)

export const DatasetFilledIcon = solidIcon(
  "database-filled",
  "M12 1C6.5 1 2 2.8 2 5s4.5 4 10 4 10-1.8 10-4-4.5-4-10-4ZM2 8.5C4.2 10.2 8 11 12 11s7.8-.8 10-2.5V12c0 2.2-4.5 4-10 4S2 14.2 2 12ZM2 15.5C4.2 17.2 8 18 12 18s7.8-.8 10-2.5V19c0 2.2-4.5 4-10 4S2 21.2 2 19Z"
)

export const ScorerFilledIcon = solidIcon(
  "triangle-filled",
  "M10.3 2a2 2 0 0 1 3.4 0l10 18a2 2 0 0 1-1.7 3H2a2 2 0 0 1-1.7-3Z"
)

export const ReviewFilledIcon = solidIcon(
  "clipboard-check-filled",
  "M9 1h6a2 2 0 0 1 2 2h1a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3V6a3 3 0 0 1 3-3h1a2 2 0 0 1 2-2ZM9 3v2h6V3ZM8 14l3 3 5-5-1.4-1.4-3.6 3.6-1.6-1.6Z"
)

export const HumanScoresFilledIcon = solidIcon(
  "list-checks-filled",
  "m2 7 3 3 5-5-2-2-3 3-1-1ZM13 3h9v3h-9ZM13 10.5h9v3h-9ZM13 18h9v3h-9ZM2 17l3 3 5-5-2-2-3 3-1-1Z"
)
