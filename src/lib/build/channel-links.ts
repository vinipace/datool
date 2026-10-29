export type ChannelLinkActivity = {
  token: string
  destination: string
  label: string
  conversationId: string
  clicks: number
  automatedVisits: number
  createdAt: string
  lastClickedAt: string | null
  expiresAt: string
}
export type ChannelLinks = { items: ChannelLinkActivity[] }
