"use client"

import { createContext } from "react"

export const ChatNavigationContext = createContext<{
  origin?: string
  navigate: (href: string) => boolean
} | null>(null)
