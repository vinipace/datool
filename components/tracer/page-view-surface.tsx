"use client"

import * as React from "react"
import { PageViewSurfaceContext, PageViewDataContext, emptyPageViewData, type PageViewCollectionData } from "./page-view-surface-context"

/** Keep query owners and header portals mounted while replacing page content. */
export function PageViewSurface({ children }: React.PropsWithChildren) {
  const [target, setTarget] = React.useState<HTMLDivElement | null>(null)
  const [active, setActive] = React.useState(false)
  const [data, setData] = React.useState(emptyPageViewData)
  const surface = React.useMemo(() => ({ target, setActive, setData }), [target])
  return <PageViewSurfaceContext.Provider value={surface}>
    <PageViewDataContext.Provider value={data}>
      <div className={active ? "hidden" : "contents"}>{children}</div>
      <div ref={setTarget} className={active ? "flex min-h-0 min-w-0 flex-1 flex-col" : "hidden"} />
    </PageViewDataContext.Provider>
  </PageViewSurfaceContext.Provider>
}

/** Resource pages supply their live data without changing the saved definition. */
export function PageViewDataSource({ data }: { data: PageViewCollectionData }) {
  const setData = React.useContext(PageViewSurfaceContext)?.setData
  React.useEffect(() => { setData?.(data) }, [setData, data])
  return null
}
