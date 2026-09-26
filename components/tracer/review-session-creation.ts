"use client"

import * as React from "react"
import type { TraceSummary } from "@/src/lib/tracer/contracts"
import { createReviewSessionCreation } from "@/src/lib/tracer/review-session-creation"
import { tracerApi } from "./api"

const creations = new Map<
  string,
  { store: ReturnType<typeof createReviewSessionCreation>; expires: number }
>()
const emptySubscribe = () => () => {}
const emptySnapshot = () => null

export function startReviewSession(scope: string, traces: TraceSummary[]) {
  for (const [key, entry] of creations) {
    if (entry.expires < Date.now() && !entry.store.getSnapshot().pending)
      creations.delete(key)
  }
  const store = createReviewSessionCreation(traces, tracerApi.reviews.create)
  const entry = { store, expires: Date.now() + 5 * 60_000 }
  creations.set(`${scope}:${store.id}`, entry)
  const unsubscribe = store.subscribe(() => {
    const { data } = store.getSnapshot()
    if (data.number) {
      creations.set(`${scope}:${data.number}`, entry)
      unsubscribe()
    }
  })
  void store.save()
  return store
}

export function useReviewSessionCreation(scope: string, id: string) {
  const store = creations.get(`${scope}:${id}`)?.store
  const snapshot = React.useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? emptySnapshot,
    emptySnapshot
  )
  return { snapshot, retry: store?.save }
}
