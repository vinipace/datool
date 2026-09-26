"use client"

import { createContext } from "react"
import type { SemanticCatalogMetadata } from "@/src/lib/semantic/catalog"
import type { RemoteState } from "./hooks"
import type { DashboardScope } from "@/src/lib/tracer/dashboard-queries"

export const DashboardCatalogContext =
  createContext<RemoteState<SemanticCatalogMetadata> | null>(null)

export const DashboardFilterScopeContext = createContext<
  DashboardScope | undefined
>(undefined)
