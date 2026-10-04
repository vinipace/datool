"use client"

import * as React from "react"
import { CustomViewControls } from "./custom-view-controls"
import { PageViewDataSource, PageViewSurface } from "./page-view-surface"
import { PageViewSurfaceContext, PageViewDataOwnerContext, type PageViewCollectionData } from "./page-view-surface-context"

/** All collection pages use the same Page View menu and Display controls. */
export function TableViewControls({ children, savedView, pageData }: React.PropsWithChildren<{
  savedView?: React.ComponentProps<typeof CustomViewControls>
  pageData?: PageViewCollectionData
}>) {
  const surface = React.useContext(PageViewSurfaceContext)
  const parentOwnsData = React.useContext(PageViewDataOwnerContext)
  const content = <PageViewDataOwnerContext.Provider value={Boolean(pageData) || parentOwnsData}>
    {pageData && <PageViewDataSource data={pageData} />}
    {savedView && <CustomViewControls {...savedView} />}
    {children}
  </PageViewDataOwnerContext.Provider>
  return surface ? content : <PageViewSurface>{content}</PageViewSurface>
}
