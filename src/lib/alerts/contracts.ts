import { z } from "zod"

export const alertConfigSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    description: z.string().trim().max(2000).default(""),
    enabled: z.boolean().default(true),
    type: z.enum(["log_event", "time_window"]),
    filter: z.string().trim().max(2000).default(""),
    notifyIntervalSeconds: z.number().int().min(60).max(604800).default(3600),
    windowSeconds: z.number().int().min(60).max(86400).default(300),
    threshold: z.number().int().min(1).max(1000000).default(1),
    action: z.enum(["in_app", "webhook"]),
    webhookUrl: z.string().trim().max(2048).default(""),
  })
  .strict()

export type AlertConfig = z.infer<typeof alertConfigSchema>
export type AlertRule = {
  id: string
  config: AlertConfig
  revision: number
  createdAt: string
  lastNotifiedAt: string | null
  lastEvaluatedAt: string | null
  lastError: string | null
}
export type AlertDelivery = {
  id: string
  alertId: string
  alertName: string
  action: "in_app" | "webhook"
  status: "pending" | "delivered" | "failed" | "cancelled"
  attempts: number
  lastError: string | null
  createdAt: string
  deliveredAt: string | null
  payload: {
    matchCount: number
    log?: { trace_id: string; name: string }
    test?: boolean
  }
}
export type AlertsResponse = {
  alerts: AlertRule[]
  deliveries: AlertDelivery[]
  workerOnline: boolean
}
export type AlertDetailResponse = { alert: AlertRule; workerOnline: boolean }
export type AlertNotification = AlertDelivery & {
  matchCount: number
  traceName: string | null
  traceId: string | null
}

export const defaultAlertConfig: AlertConfig = {
  name: "",
  description: "",
  enabled: true,
  type: "log_event",
  filter: "",
  notifyIntervalSeconds: 3600,
  windowSeconds: 300,
  threshold: 1,
  action: "in_app",
  webhookUrl: "",
}
