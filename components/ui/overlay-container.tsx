"use client"

import { createContext, useContext, type RefObject } from "react"

/** Keep nested popup portals inside a modal's focus and pointer boundary. */
export const OverlayContainer =
  createContext<RefObject<HTMLDivElement | null> | null>(null)
export function useOverlayContainer() {
  return useContext(OverlayContainer)
}
