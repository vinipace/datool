/** Exchange with the exact parent window and origin; timeouts never silently downgrade Shopify identity. */
export function requestHostSession<T>(
  origin: string,
  input: {
    newConversation?: boolean
    conversationId?: string
    challengeToken?: string
  } = {}
): Promise<{
  session?: T
  shopify?: boolean
  error?: {
    message?: string
    code?: string
    siteKey?: string
    connectionId?: string
  }
}> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID()
    const finish = () => {
      clearTimeout(timeout)
      window.removeEventListener("message", receive)
    }
    const receive = (event: MessageEvent) => {
      if (
        event.source !== window.parent ||
        event.origin !== origin ||
        event.data?.type !== "datool:chat:session-response" ||
        event.data.requestId !== requestId
      )
        return
      finish()
      resolve(event.data)
    }
    const timeout = setTimeout(() => {
      finish()
      reject(
        new Error(
          "The store session could not be verified. Please refresh the page."
        )
      )
    }, 20_000)
    window.addEventListener("message", receive)
    window.parent.postMessage(
      { type: "datool:chat:session-request", requestId, ...input },
      origin
    )
  })
}
