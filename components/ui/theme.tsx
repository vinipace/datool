"use client"

import { useEffect } from "react"
import { applyTheme, useThemeMode } from "@/lib/theme"

/** The initial document script sets colors before paint; this keeps OS/tab changes in sync. */
export function ThemeSync() {
  const mode = useThemeMode()
  useEffect(() => applyTheme(mode), [mode])
  return null
}
