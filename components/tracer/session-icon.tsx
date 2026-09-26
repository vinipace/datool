"use client"

import { createLucideIcon } from "lucide-react"

/** Shared circular chat bubbles for session navigation and span-style badges. */
export const SessionIcon = createLucideIcon("messages-circle", [
  ["path", { d: "M9 15a7 7 0 1 0-6-3.4L2 16l4.4-1A7 7 0 0 0 9 15Z", key: "front" }],
  ["path", { d: "M17 8a7 7 0 0 1 4 10l1 4-4-1a7 7 0 0 1-10-4", key: "back" }],
])
