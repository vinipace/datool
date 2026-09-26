"use client"

import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { cn } from "@/lib/utils"

/** Variable-height rows, with loading/error content after the virtual extent. */
export function VirtualList<T>({
  items,
  itemKey,
  children,
  scrollRef,
  label,
  estimatedRowHeight = 42,
  footer,
  empty,
  className,
}: {
  items: T[]
  itemKey: (item: T, index: number) => string
  children: (item: T, index: number) => React.ReactNode
  scrollRef: React.RefObject<HTMLDivElement | null>
  label: string
  estimatedRowHeight?: number
  footer?: React.ReactNode
  empty?: React.ReactNode
  className?: string
}) {
  // TanStack's virtualizer exposes mutable methods, so this component must not
  // be memoized by React Compiler.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: index => itemKey(items[index], index),
    estimateSize: () => estimatedRowHeight,
    overscan: 8,
  })

  return <div ref={scrollRef} role="region" aria-label={label} tabIndex={0}
    className={cn("h-full min-h-0 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring", className)}>
    <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map(row => <div key={row.key} ref={virtualizer.measureElement} data-index={row.index}
        className="absolute top-0 left-0 flow-root w-full" style={{ transform: `translateY(${row.start}px)` }}>
        {children(items[row.index], row.index)}
      </div>)}
    </div>
    {!items.length ? empty : null}
    {footer}
  </div>
}
