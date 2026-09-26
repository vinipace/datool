"use client"

import { useSyncExternalStore } from "react"

const subscribe = () => () => {}
const clientSnapshot = () => true
const serverSnapshot = () => false

/** Prevent controlled server-rendered inputs from losing edits before hydration. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, clientSnapshot, serverSnapshot)
}
