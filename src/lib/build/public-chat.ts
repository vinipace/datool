export type PublicChatThread = { id: string; title: string; updatedAt: string }

/** A queued request is still waiting after its HTTP acknowledgement. */
export function isPublicReplyPending(
  messages: Array<{
    direction?: string
    pendingReply?: boolean
    text?: string
    attachments?: unknown[]
  }>
) {
  const inbound = messages.findLastIndex(
    (message) => message.direction === "inbound"
  )
  return (
    inbound >= 0 &&
    messages[inbound]?.pendingReply === true &&
    !messages
      .slice(inbound + 1)
      .some(
        (message) =>
          message.direction === "outbound" &&
          (message.text?.trim() || message.attachments?.length)
      )
  )
}
