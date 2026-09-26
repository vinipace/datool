export type OrganizationMember = {
  id: string
  userId: string
  name: string
  email: string
  role: string
  createdAt: string
}
export type OrganizationInvitation = {
  id: string
  email: string
  role: string
  expiresAt: string
  expired: boolean
  createdAt: string
  emailStatus: "pending" | "sent" | "failed" | null
}
export type OrganizationMembers = {
  members: OrganizationMember[]
  invitations: OrganizationInvitation[]
  canManage: boolean
  currentUserId: string
  role: string
  emailConfigured: boolean
}
