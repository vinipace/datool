"use client"

import * as React from "react"
import { CustomViewControls } from "./custom-view-controls"

/** All collection pages use the same Page View menu and Display controls. */
export function TableViewControls({ children, savedView }: React.PropsWithChildren<{
  savedView?: React.ComponentProps<typeof CustomViewControls>
}>) {
  return <>
    {savedView && <CustomViewControls {...savedView} />}
    {children}
  </>
}
