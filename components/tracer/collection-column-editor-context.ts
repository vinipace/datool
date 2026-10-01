"use client"

import { createContext } from "react"

/** Lets custom header editors expose their existing dialog to the shared menu. */
export const CollectionColumnEditorContext = createContext<((handler: (() => void) | null) => void) | null>(null)
