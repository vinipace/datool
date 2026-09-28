"use client"

import { createContext } from "react"

export type HeaderSlotName = "title" | "tabs" | "pageView" | "filter" | "actions" | "refresh" | "display" | "menu" | "selection"
export const CollectionHeaderContext = createContext<Partial<Record<HeaderSlotName, HTMLDivElement | null>> & { refreshInMenu?: boolean; displayIconOnly?: boolean }>({})
