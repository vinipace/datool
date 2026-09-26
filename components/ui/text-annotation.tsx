"use client"

import * as React from "react"
import { MessageSquarePlus } from "lucide-react"
import { Button } from "./button"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"

export type TextAnchor = {
  start: number
  end: number
  exact: string
  prefix: string
  suffix: string
}

function textRange(element: HTMLElement, start: number, end: number) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  let offset = 0
  let foundStart = false
  while (walker.nextNode()) {
    const node = walker.currentNode
    const length = node.textContent?.length ?? 0
    if (!foundStart && start < offset + length) {
      range.setStart(node, start - offset)
      foundStart = true
    }
    if (foundStart && end <= offset + length) {
      range.setEnd(node, end - offset)
      return range
    }
    offset += length
  }
  return null
}

function matches(text: string, anchor: TextAnchor) {
  return (
    text.slice(anchor.start, anchor.end) === anchor.exact &&
    text.slice(
      Math.max(0, anchor.start - anchor.prefix.length),
      anchor.start
    ) === anchor.prefix &&
    text.slice(anchor.end, anchor.end + anchor.suffix.length) === anchor.suffix
  )
}

/** Highlights use browser ranges without changing React's rendered output nodes. */
export function TextAnnotation({
  children,
  anchors,
  active,
  onAnnotate,
  disabled,
}: React.PropsWithChildren<{
  anchors: TextAnchor[]
  active?: TextAnchor
  onAnnotate: (anchor: TextAnchor) => void
  disabled?: boolean
}>) {
  const content = React.useRef<HTMLDivElement>(null)
  const [selection, setSelection] = React.useState<{
    anchor: TextAnchor
    rect: DOMRect
  } | null>(null)
  const [unmatched, setUnmatched] = React.useState(false)
  const instance = React.useId().replace(/[^a-zA-Z0-9]/g, "")
  const highlightName = `annotation-${instance}`
  React.useEffect(() => {
    const element = content.current
    if (!element) return
    const update = () => {
      const text = element.textContent ?? ""
      const ranges = [...anchors, ...(active ? [active] : [])]
        .filter((anchor) => matches(text, anchor))
        .flatMap((anchor) => textRange(element, anchor.start, anchor.end) ?? [])
      if (typeof Highlight !== "undefined" && CSS.highlights)
        CSS.highlights.set(highlightName, new Highlight(...ranges))
      setUnmatched(Boolean(active && !matches(text, active)))
    }
    update()
    // Tree/message renderers may disclose text after the first render.
    const observer = new MutationObserver(update)
    observer.observe(element, {
      childList: true,
      characterData: true,
      subtree: true,
    })
    return () => {
      observer.disconnect()
      if (typeof CSS !== "undefined" && CSS.highlights)
        CSS.highlights.delete(highlightName)
    }
  }, [anchors, active, highlightName])
  React.useEffect(() => {
    const element = content.current
    if (!active || !element || !matches(element.textContent ?? "", active))
      return
    const range = textRange(element, active.start, active.end)
    if (!range) return
    for (
      let parent = element.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      if (
        parent.scrollHeight > parent.clientHeight &&
        /(auto|scroll)/.test(getComputedStyle(parent).overflowY)
      ) {
        parent.scrollBy({
          top:
            range.getBoundingClientRect().top -
            parent.getBoundingClientRect().top -
            parent.clientHeight / 3,
          behavior: "smooth",
        })
        break
      }
    }
  }, [active])
  function capture() {
    const element = content.current
    const selected = window.getSelection()
    if (!element || !selected || selected.isCollapsed || !selected.rangeCount)
      return setSelection(null)
    const range = selected.getRangeAt(0)
    if (
      !element.contains(range.startContainer) ||
      !element.contains(range.endContainer)
    )
      return setSelection(null)
    const before = range.cloneRange()
    before.selectNodeContents(element)
    before.setEnd(range.startContainer, range.startOffset)
    const start = before.toString().length
    const exact = range.toString()
    if (!exact.trim() || exact.length > 8000) return setSelection(null)
    const end = start + exact.length
    const text = element.textContent ?? ""
    setSelection({
      rect: range.getBoundingClientRect(),
      anchor: {
        start,
        end,
        exact,
        prefix: text.slice(Math.max(0, start - 64), start),
        suffix: text.slice(end, end + 64),
      },
    })
  }
  return (
    <div className="relative min-w-0">
      <style>{`::highlight(${highlightName}) { background-color: var(--selection); color: var(--selection-foreground); text-decoration: underline; text-decoration-color: var(--selection-control); }`}</style>
      {!disabled && (
        <Popover
          open={Boolean(selection)}
          onOpenChange={(open) => {
            if (!open) setSelection(null)
          }}
        >
          <PopoverAnchor
            virtualRef={{
              current: selection
                ? { getBoundingClientRect: () => selection.rect }
                : null,
            }}
          />
          <PopoverContent
            aria-label="Annotation actions"
            side="top"
            className="w-auto p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                if (selection) onAnnotate(selection.anchor)
                setSelection(null)
              }}
            >
              <MessageSquarePlus /> Comment on selection
            </Button>
          </PopoverContent>
        </Popover>
      )}
      {unmatched && (
        <p role="status" className="mb-2 text-xs text-foreground-muted">
          The passage is not visible in this field. Its original quote is
          preserved in the comment.
        </p>
      )}
      <div
        ref={content}
        data-annotation-content=""
        onMouseUp={capture}
        onKeyUp={capture}
      >
        {children}
      </div>
    </div>
  )
}
