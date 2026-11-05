"use client"

import { useSyncExternalStore } from "react"

export type ThemeMode = "light" | "dark" | "system"
const storageKey = "datool:theme"
const changeEvent = "datool:theme-change"
let fallback: ThemeMode = "system"

function readTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey)
    return value === "light" || value === "dark" || value === "system"
      ? value
      : "system"
  } catch {
    return fallback
  }
}

export function applyTheme(mode: ThemeMode) {
  const resolved =
    mode === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : mode
  document.documentElement.classList.remove("light", "dark")
  document.documentElement.classList.add(resolved)
  document.documentElement.style.colorScheme = resolved
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const update = () => {
    applyTheme(readTheme())
    onChange()
  }
  const storage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) update()
  }
  const system = () => {
    if (readTheme() === "system") update()
  }
  window.addEventListener(changeEvent, update)
  window.addEventListener("storage", storage)
  media.addEventListener("change", system)
  return () => {
    window.removeEventListener(changeEvent, update)
    window.removeEventListener("storage", storage)
    media.removeEventListener("change", system)
  }
}

export function setThemeMode(mode: ThemeMode) {
  fallback = mode
  try {
    localStorage.setItem(storageKey, mode)
  } catch {
    /* Keep the choice for this tab when storage is blocked. */
  }
  applyTheme(mode)
  window.dispatchEvent(new Event(changeEvent))
}

export function useThemeMode() {
  return useSyncExternalStore(subscribe, readTheme, () => "system" as const)
}
