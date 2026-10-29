export const EVOLUTION_ACCEPTANCE_VERSION = "2026-10-26"
export type EvolutionConnection = {
  enabled: boolean
  connectionId: string
  status: string
  state: string
  phone: string | null
  checkedAt: string | null
  cleanupPending: boolean
}
export type EvolutionPairing = EvolutionConnection & {
  qr: string | null
  expiresAt: string | null
}
