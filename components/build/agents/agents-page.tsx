"use client"

import { PerformancePage } from "@/components/tracer/performance-page"

export function BuildLandingPage() {
  return <BuildAgentsPage />
}

export function BuildAgentsPage() {
  return <PerformancePage model="agents" includeManagedAgents />
}
