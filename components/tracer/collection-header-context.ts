"use client"

import { createContext } from "react"

export type HeaderSlotName = "title" | "tabs" | "filter" | "actions" | "refresh" | "display" | "menu" | "selection"
export const CollectionHeaderContext = createContext<Partial<Record<HeaderSlotName, HTMLDivElement | null>> & { refreshInMenu?: boolean; displayIconOnly?: boolean }>({})
