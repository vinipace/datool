"use client"

import * as React from "react"

export function useWideViewport(minWidth = 1280) {
  const [isWide, setIsWide] = React.useState(false)

  React.useEffect(() => {
    const query = window.matchMedia(`(min-width: ${minWidth}px)`)
    const update = () => setIsWide(query.matches)
    update()
    query.addEventListener("change", update)
    return () => query.removeEventListener("change", update)
  }, [minWidth])

  return isWide
}
