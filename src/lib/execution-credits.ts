import type { CloudPlan } from "./billing"

export const NANO_USD = 1_000_000_000
export const executionAllowances: Record<CloudPlan, number> = {
  core: 5,
  pro: 25,
}
export const DATOOL_PROVIDER = "datool" as const
export const DATOOL_SCORER_MODEL = "gpt-6-luna"
export const formatCredits = (amount: number) =>
  amount > 0 && amount < 0.01
    ? "<$0.01"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(amount)
export type ExecutionUsage = {
  plan: CloudPlan | null
  periodStart: string | null
  periodEnd: string | null
  allowance: number
  used: number
  reserved: number
  remaining: number
  model: number
  sandbox: number
  pendingRuns: number
  projects: {
    id: string
    name: string
    model: number
    sandbox: number
    reserved: number
  }[]
}
