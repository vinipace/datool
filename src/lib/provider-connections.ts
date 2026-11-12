export type ProviderConnectionInfo = {
  connectionId: string
  provider: string
  name: string
  isDefault: boolean
  metadata?: { teamId: string; projectId: string }
  projects: { id: string; name: string }[]
}
