/** Attribution is produced by authenticated server context, never review input. */
export type ReviewProvenance = {
  label: "AI-labelled" | "Human-reviewed" | "Unknown provenance"
  authType: "api-key" | "oauth" | "session" | "unknown"
  principal: { type: "api-key" | "user"; id: string; name: string } | null
  clientId?: string
  agent?: { name?: string; model?: string }
}

export function reviewAttribution(provenance?: ReviewProvenance | null) {
  if (!provenance) return "Unknown provenance"
  return [
    provenance.label,
    provenance.principal?.name,
    provenance.agent?.name,
    provenance.agent?.model,
  ]
    .filter(Boolean)
    .join(" · ")
}
