"use client"

import * as React from "react"

export const InspectorPanelContext = React.createContext<{
  open: boolean
  target: HTMLDivElement | null
  setOpen: React.Dispatch<React.SetStateAction<boolean>>
  setDefaultSize?: React.Dispatch<React.SetStateAction<number>>
  maximized: boolean
  setMaximized: React.Dispatch<React.SetStateAction<boolean>>
  narrow: boolean
} | null>(null)
