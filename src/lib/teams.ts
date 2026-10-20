export type TeamMember = {
  id: string
  name: string
  image: string | null
  email: string
}
export type OrganizationTeam = {
  id: string
  organizationId?: string
  name: string
  description: string
  enabled: boolean
  memberIds: string[]
  memberCount: number
  updatedAt?: string
}
export type TeamEditorInput = {
  id?: string
  name: string
  description: string
  memberIds: string[]
  enabled: boolean
}
export type OrganizationTeams = {
  teams: OrganizationTeam[]
  members: TeamMember[]
  canManage: boolean
}
