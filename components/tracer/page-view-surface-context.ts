"use client"

import { createContext } from "react"
import type { PageViewInput } from "@/src/lib/tracer/react-page-views"

export type PageViewCollectionData = Omit<PageViewInput["page"], "resource" | "queryParams"> & {
  rows: unknown[]
  refresh?: () => void
  loadMore?: () => void
}
export const emptyPageViewData: PageViewCollectionData = {
  rows: [], total: null, isLoading: false, isRefreshing: false,
  hasMore: false, isLoadingMore: false, error: null,
}
export const PageViewSurfaceContext = createContext<{
  target: HTMLDivElement | null
  setActive: (active: boolean) => void
  setData: (data: PageViewCollectionData) => void
} | null>(null)
export const PageViewDataContext = createContext(emptyPageViewData)
export const PageViewDataOwnerContext = createContext(false)
