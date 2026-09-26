"use client"

import * as React from "react"
import { CustomViewControls } from "./custom-view-controls"
import { HeaderSlot } from "./collection-header"
import { CollectionHeaderContext } from "./collection-header-context"

/** Groups saved views and the table's Display control in one reusable header slot. */
export function TableViewControls({ children, savedView }: React.PropsWithChildren<{
  savedView?: React.ComponentProps<typeof CustomViewControls>
}>) {
  const inherited = React.useContext(CollectionHeaderContext)
  const [viewsTarget, setViewsTarget] = React.useState<HTMLDivElement | null>(null)
  const [displayTarget, setDisplayTarget] = React.useState<HTMLDivElement | null>(null)
  return <>
    <HeaderSlot name="display">
      <div role="group" aria-label="Table view controls" className="flex items-center gap-1">
        <div ref={setViewsTarget} className="flex min-w-0 items-center" />
        <div ref={setDisplayTarget} className="flex items-center" />
      </div>
    </HeaderSlot>
    {savedView && <CollectionHeaderContext.Provider value={{ ...inherited, filter: viewsTarget }}>
      <CustomViewControls {...savedView} />
    </CollectionHeaderContext.Provider>}
    <CollectionHeaderContext.Provider value={{ ...inherited, display: displayTarget }}>
      {children}
    </CollectionHeaderContext.Provider>
  </>
}
