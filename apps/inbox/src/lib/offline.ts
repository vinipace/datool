import AsyncStorage from "@react-native-async-storage/async-storage"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { onlineManager, useQuery } from "@tanstack/react-query"
import { useSyncExternalStore } from "react"
import { auth } from "./auth"
import { STORAGE_SCOPE } from "./server-url"
import { ApiError, build } from "./api"
import { queryClient } from "./query"
import { DurableOutbox, ReplyBlockedError, type QueuedReply } from "./outbox-core"
import type { Ownership } from "./types"

export const persister = createAsyncStoragePersister({ storage: AsyncStorage, key: `datool-inbox-cache:${STORAGE_SCOPE}`, throttleTime: 500 })
export const outbox = new DurableOutbox(AsyncStorage, `datool-inbox-outbox:${STORAGE_SCOPE}`)
outbox.subscribe(() => { void queryClient.invalidateQueries({ queryKey: ["outbox"] }) })
export const useOnline = () => useSyncExternalStore(listener => onlineManager.subscribe(listener), () => onlineManager.isOnline(), () => true)
export function useOutbox(userId?: string) {
  return useQuery({ queryKey: ["outbox", userId], enabled: !!userId, networkMode: "always", queryFn: () => outbox.list(userId!), staleTime: 0 })
}
export async function sendQueuedReply(reply: QueuedReply) {
  const session = await auth.getSession({ query: { disableCookieCache: true } })
  if (session.error) throw new Error("Could not verify your session. Your reply is saved.")
  if (session.data?.user.id !== reply.userId) throw new ReplyBlockedError("Sign in with the account that wrote this reply, then retry.", "auth")
  const send = () => build<{ messageId?: string }>(reply.projectId, "build_send_human_reply", { conversationId: reply.conversationId, text: reply.text, clientMessageId: reply.id }, { key: reply.id })
  try {
    // Retry with the original ID: an earlier request may have committed even
    // when its response never reached this phone. Ownership is rechecked.
    try {
      return await send()
    } catch (error) {
      if (error instanceof ApiError && error.reason === "LEASE_EXPIRED") {
        const owner = await build<Ownership>(reply.projectId, "build_get_conversation_ownership", { conversationId: reply.conversationId })
        if (owner.mode === "human" && owner.ownerUserId === reply.userId) {
          await build(reply.projectId, "build_takeover_conversation", { conversationId: reply.conversationId, expectedVersion: owner.version })
          return await send()
        }
      }
      throw error
    }
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) throw new ReplyBlockedError(error.status === 409 ? "Conversation ownership changed. Open the ticket and join it before retrying." : error.message, error.status === 401 ? "auth" : "permission")
    throw error
  }
}
export async function syncOutbox(userId: string) {
  await outbox.drain(userId, sendQueuedReply, () => onlineManager.isOnline() && queryClient.getQueryData<{ user: { id: string } }>(["session"])?.user.id === userId)
  await Promise.all([queryClient.invalidateQueries({ queryKey: ["messages"] }), queryClient.invalidateQueries({ queryKey: ["inbox"] })])
}
