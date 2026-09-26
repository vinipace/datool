import type { PropsWithChildren, Ref } from "react"
import { Search } from "lucide-react"

/** Shared search chrome for plain text and token filters. */
export function SearchBarSurface({
  children,
  surfaceRef,
  onFocusInput,
}: PropsWithChildren<{
  surfaceRef?: Ref<HTMLDivElement>
  onFocusInput: () => void
}>) {
  return (
    <div data-slot="filter-bar" className="relative h-9 w-full">
      <div
        ref={surfaceRef}
        data-slot="filter-bar-surface"
        className="absolute inset-x-0 top-0 flex h-9 max-h-[min(20rem,50dvh)] w-full items-start gap-1 overflow-hidden rounded border border-border-strong bg-muted px-1.5 py-0.75 transition-colors focus-within:z-50 focus-within:h-auto focus-within:min-h-9 focus-within:overflow-y-auto focus-within:border-selection-control focus-within:ring-1 focus-within:ring-selection-control has-[[data-state=open]]:z-50 has-[[data-state=open]]:h-auto has-[[data-state=open]]:min-h-10 has-[[data-state=open]]:overflow-y-auto @max-[640px]/collection:focus-within:w-[100cqw] @max-[640px]/collection:has-[[data-state=open]]:w-[100cqw]"
        onPointerDown={(event) => {
          if (
            !(event.target instanceof Element) ||
            !event.currentTarget.contains(event.target) ||
            event.target.closest("button, input, [contenteditable]")
          )
            return
          event.preventDefault()
          onFocusInput()
        }}
      >
        <Search
          aria-hidden="true"
          className="mt-1.5 size-4 shrink-0 text-foreground-subtle"
        />
        {children}
      </div>
    </div>
  )
}
