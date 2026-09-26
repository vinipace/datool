import * as React from "react"
import { Extension } from "@tiptap/core"
import Document from "@tiptap/extension-document"
import Paragraph from "@tiptap/extension-paragraph"
import Placeholder from "@tiptap/extension-placeholder"
import Text from "@tiptap/extension-text"
import { EditorContent, useEditor, type Editor } from "@tiptap/react"
import { Plugin, PluginKey, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { CornerDownLeft, ListFilter, Search, XIcon } from "lucide-react"
import {
  applySuggestionToValue,
  getSearchSuggestions,
  getSelectorHighlightRanges,
  type SearchField as DataTableSearchField,
  type SearchSuggestion as DataTableSearchSuggestion,
} from "./search-core"

import {
  applyFilterSuggestion,
  getFilterSuggestions,
  getFilterHighlightRanges,
  formatFilterQuery,
} from "./filter-query"
import { cx } from "class-variance-authority"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { filterDraftSuggestions, type FixedFilter } from "./filter-draft"
import { SyntaxCode } from "@/components/ui/syntax-code"

export type DataTableSearchInputHandle = {
  focus: () => void
  selectAll: () => void
}

type ControlledDataTableSearchInputProps<Row> = {
  fields: DataTableSearchField<Row>[]
  onSearchChange: (value: string) => void
  value: string
}

export type DataTableSearchInputProps<Row> = {
  fixedFilters?: readonly FixedFilter[]
  embedded?: boolean
  suggestionAnchorRef?: React.RefObject<HTMLDivElement | null>
  onSubmit?: (value: string) => void
  syntax?: "search" | "filter"
  inputRef?: React.Ref<DataTableSearchInputHandle>
  isLoading?: boolean
  placeholder?: string
} & ControlledDataTableSearchInputProps<Row>

const selectorPluginKey = new PluginKey(
  "data-table-search-selector-highlighter"
)
const selectorRefreshKey = "refresh-data-table-search-selector-highlighter"
type HighlighterState = {
  fields: DataTableSearchField<unknown>[]
  syntax: "search" | "filter"
}

function createSelectorDecorations(
  doc: Editor["state"]["doc"],
  context: HighlighterState
) {
  const ranges = (
    context.syntax === "filter"
      ? getFilterHighlightRanges
      : getSelectorHighlightRanges
  )(getPlainText(doc), context.fields)

  return DecorationSet.create(
    doc,
    ranges
      .map((range) => {
        const from = textOffsetToDocPosition(doc, range.start)
        const to = textOffsetToDocPosition(doc, range.end)

        if (from >= to) {
          return null
        }

        return Decoration.inline(
          from,
          to,
          {
            class: "data-table-search-input-selector-token",
            nodeName: "span",
            "data-search-field-id": range.fieldId,
            "data-search-field-kind":
              range.fieldId === "$text"
                ? "fulltext"
                : (context.fields.find((field) => field.id === range.fieldId)
                    ?.kind ?? "text"),
            "data-table-search-selector": "",
          },
          {
            inclusiveEnd: false,
            inclusiveStart: false,
          }
        )
      })
      .filter((decoration): decoration is Decoration => decoration !== null)
  )
}

const DataTableSelectorHighlighter = Extension.create<HighlighterState>({
  name: "dataTableSelectorHighlighter",
  addProseMirrorPlugins() {
    let context = this.options
    return [
      new Plugin({
        key: selectorPluginKey,
        state: {
          init: (_, state) => createSelectorDecorations(state.doc, context),
          apply: (transaction, decorationSet, _oldState, newState) => {
            const refreshed = transaction.getMeta(selectorRefreshKey) as
              HighlighterState | undefined
            if (refreshed) context = refreshed
            if (
              transaction.docChanged ||
              transaction.getMeta(selectorRefreshKey)
            ) {
              return createSelectorDecorations(newState.doc, context)
            }

            return decorationSet.map(transaction.mapping, transaction.doc)
          },
        },
        props: {
          decorations(state) {
            return selectorPluginKey.getState(state)
          },
        },
      }),
    ]
  },
})

function assignRefValue<T>(ref: React.Ref<T> | undefined, value: T | null) {
  if (typeof ref === "function") {
    ref(value)
    return
  }

  if (ref) {
    ref.current = value
  }
}

function createEditorDocument(value: string) {
  return {
    content: value
      ? [
          {
            content: [
              {
                text: value,
                type: "text",
              },
            ],
            type: "paragraph",
          },
        ]
      : [
          {
            type: "paragraph",
          },
        ],
    type: "doc",
  } as const
}

function getPlainText(doc: Editor["state"]["doc"]) {
  return doc.textBetween(0, doc.content.size, "", "")
}

function getCursorOffset(editor: Editor) {
  return editor.state.doc.textBetween(0, editor.state.selection.from, "", "")
    .length
}

function textOffsetToDocPosition(doc: Editor["state"]["doc"], offset: number) {
  const totalLength = getPlainText(doc).length
  const clampedOffset = Math.max(0, Math.min(offset, totalLength))
  let remaining = clampedOffset
  let position = TextSelection.atStart(doc).from

  doc.descendants((node, pos) => {
    if (!node.isText) {
      return true
    }

    const text = node.text ?? ""

    if (remaining <= text.length) {
      position = pos + remaining
      return false
    }

    remaining -= text.length
    position = pos + text.length

    return true
  })

  return position
}

function normalizeSingleLineText(value: string) {
  return value.replace(/\r\n?/g, "\n").replace(/\n/g, " ")
}

function moveActiveIndex(
  currentIndex: number,
  totalItems: number,
  direction: 1 | -1
) {
  if (totalItems <= 0) {
    return -1
  }

  if (currentIndex < 0) {
    return direction === 1 ? 0 : totalItems - 1
  }

  return (currentIndex + direction + totalItems) % totalItems
}

function SuggestionPanel({
  embedded,
  anchorRef,
  popupRef,
  onOpenChange,
  children,
}: {
  embedded: boolean
  anchorRef: React.RefObject<HTMLDivElement | null>
  popupRef: React.RefObject<HTMLDivElement | null>
  onOpenChange: (open: boolean) => void
  children: React.ReactNode
}) {
  if (!embedded) return <div className="mt-1 w-full">{children}</div>
  return (
    <Popover open onOpenChange={onOpenChange}>
      <PopoverAnchor virtualRef={anchorRef} />
      <PopoverContent
        ref={popupRef}
        className="w-[var(--radix-popover-trigger-width)] overflow-hidden bg-background p-0"
        aria-label="Filter suggestions"
        onInteractOutside={(event) => {
          // The combobox keeps focus outside the portaled suggestion content.
          const target = event.detail.originalEvent.target
          if (target instanceof Node && anchorRef.current?.contains(target))
            event.preventDefault()
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
      >
        {children}
      </PopoverContent>
    </Popover>
  )
}

export function DataTableSearchInput<Row extends Record<string, unknown>>({
  embedded = false,
  suggestionAnchorRef,
  onSubmit,
  fields,
  syntax = "search",
  inputRef,
  isLoading = false,
  onSearchChange,
  placeholder = "Search table...",
  value,
}: DataTableSearchInputProps<Row>) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const popupRef = React.useRef<HTMLDivElement | null>(null)
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([])
  const valueRef = React.useRef(value ?? "")
  const openRef = React.useRef(false)
  const activeIndexRef = React.useRef(-1)
  const suppressNextFocusOpenRef = React.useRef(false)
  const latestSuggestionsRef = React.useRef<DataTableSearchSuggestion[]>([])
  const applySuggestionRef = React.useRef<
    (
      editorInstance: Editor | null,
      suggestion: DataTableSearchSuggestion
    ) => void
  >(() => {})
  const pendingSelectionRef = React.useRef<{
    end: number
    start: number
  } | null>(null)
  const [cursorOffset, setCursor] = React.useState(0)
  const cursor = Math.min(cursorOffset, value.length)
  const [open, setOpenState] = React.useState(false)
  const [requestedIndex, setActiveIndex] = React.useState(-1)
  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next)
    if (!next) {
      setActiveIndex(-1)
      activeIndexRef.current = -1
    }
  }, [])
  const [focused, setFocused] = React.useState(false)
  const suggestionListId = React.useId()
  const submitRef = React.useRef(onSubmit)
  React.useEffect(() => {
    submitRef.current = onSubmit
  }, [onSubmit])

  const summary = React.useMemo(
    () => (syntax === "filter" ? formatFilterQuery(value, fields) : null),
    [syntax, value, fields]
  )
  const showSummary = !embedded && !focused && summary !== null

  const setActiveSuggestionIndex = React.useCallback((nextIndex: number) => {
    activeIndexRef.current = nextIndex
    setActiveIndex(nextIndex)
  }, [])

  const suggestions = React.useMemo(
    () => [
      ...(onSubmit ? filterDraftSuggestions(value, fields) : []),
      ...(syntax === "filter" ? getFilterSuggestions : getSearchSuggestions)(
        value,
        cursor,
        fields
      ),
    ],
    [cursor, fields, value, syntax, onSubmit]
  )
  const activeIndex =
    open && suggestions.length
      ? Math.min(
          requestedIndex < 0 && onSubmit && value.trim() ? 0 : requestedIndex,
          suggestions.length - 1
        )
      : -1
  const inputSuggestions = React.useMemo(
    () => suggestions.filter((suggestion) => suggestion.group === "input"),
    [suggestions]
  )
  const valueSuggestions = React.useMemo(
    () => suggestions.filter((suggestion) => suggestion.group === "values"),
    [suggestions]
  )
  const filterSuggestions = React.useMemo(
    () => suggestions.filter((suggestion) => suggestion.group === "filters"),
    [suggestions]
  )

  const syncEditorValue = React.useCallback(
    (
      editorInstance: Editor,
      nextValue: string,
      selection?: {
        end: number
        start: number
      }
    ) => {
      editorInstance.commands.setContent(createEditorDocument(nextValue), {
        emitUpdate: false,
        parseOptions: { preserveWhitespace: "full" },
      })

      if (selection) {
        editorInstance.commands.setTextSelection({
          from: textOffsetToDocPosition(
            editorInstance.state.doc,
            selection.start
          ),
          to: textOffsetToDocPosition(editorInstance.state.doc, selection.end),
        })
      }
    },
    []
  )

  const applySuggestion = React.useCallback(
    (editorInstance: Editor | null, suggestion: DataTableSearchSuggestion) => {
      if (suggestion.id.startsWith("submit-")) {
        setOpen(false)
        submitRef.current?.(suggestion.insertText)
        return
      }
      const nextState = (
        syntax === "filter" ? applyFilterSuggestion : applySuggestionToValue
      )(value, cursor, fields, suggestion)

      if (
        submitRef.current &&
        !nextState.keepOpen &&
        formatFilterQuery(nextState.value, fields)
      ) {
        setOpen(false)
        submitRef.current(nextState.value.trim())
        return
      }

      pendingSelectionRef.current = {
        end: nextState.selectionStart,
        start: nextState.selectionStart,
      }
      setCursor(nextState.selectionStart)
      setOpen(nextState.keepOpen)

      if (!nextState.keepOpen) {
        suppressNextFocusOpenRef.current = true
      }

      if (editorInstance) {
        syncEditorValue(
          editorInstance,
          nextState.value,
          pendingSelectionRef.current
        )
        editorInstance.commands.focus()
      }

      onSearchChange(nextState.value)
    },
    [
      cursor,
      fields,
      onSearchChange,
      syncEditorValue,
      value,
      syntax,
      setOpen,
      setCursor,
    ]
  )

  const editor = useEditor(
    {
      content: createEditorDocument(value),
      editorProps: {
        attributes: {
          role: onSubmit ? "combobox" : "textbox",
          "aria-label":
            syntax === "filter" ? "Filter expression" : "Search table",
          "aria-multiline": "false",
          autocapitalize: "off",
          autocomplete: "off",
          autocorrect: "off",
          class: embedded
            ? "data-table-search-input-editor min-w-0 flex-1 px-1 py-1 h-full text-xs outline-none"
            : "data-table-search-input-editor min-w-0 flex-1 px-2 py-2 h-full text-sm outline-none",
          spellcheck: "false",
        },
        handleKeyDown: (_view, event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            suppressNextFocusOpenRef.current = true
            setOpen(false)
            return true
          }

          if (event.key === "ArrowDown") {
            event.preventDefault()
            setOpen(true)
            setActiveSuggestionIndex(
              moveActiveIndex(
                activeIndexRef.current,
                latestSuggestionsRef.current.length,
                1
              )
            )
            return true
          }

          if (event.key === "ArrowUp") {
            event.preventDefault()
            setOpen(true)
            setActiveSuggestionIndex(
              moveActiveIndex(
                activeIndexRef.current,
                latestSuggestionsRef.current.length,
                -1
              )
            )
            return true
          }

          if (event.key === "Tab") {
            if (submitRef.current) return false
            const activeSuggestion =
              latestSuggestionsRef.current[activeIndexRef.current]

            if (!openRef.current || !activeSuggestion) {
              return false
            }

            event.preventDefault()
            applySuggestionRef.current(editor, activeSuggestion)
            return true
          }

          if (event.key === "Enter") {
            event.preventDefault()
            event.stopPropagation()

            const activeSuggestion =
              latestSuggestionsRef.current[activeIndexRef.current]

            if (openRef.current && activeSuggestion) {
              applySuggestionRef.current(editor, activeSuggestion)
            } else if (editor) {
              setCursor(getCursorOffset(editor))
              setOpen(false)
              const submission = latestSuggestionsRef.current.find((item) =>
                item.id.startsWith("submit-")
              )
              if (submission) applySuggestionRef.current(editor, submission)
              else if (!valueRef.current.trim()) submitRef.current?.("")
            }

            return true
          }

          return false
        },
        handlePaste: (view, event) => {
          const pastedText = event.clipboardData?.getData("text/plain")

          if (typeof pastedText !== "string") {
            return false
          }

          event.preventDefault()
          view.dispatch(
            view.state.tr.insertText(
              normalizeSingleLineText(pastedText),
              view.state.selection.from,
              view.state.selection.to
            )
          )
          return true
        },
      },
      extensions: [
        Document,
        Paragraph,
        Text,
        Placeholder.configure({
          placeholder,
        }),
        DataTableSelectorHighlighter.configure({
          fields: fields as DataTableSearchField<unknown>[],
          syntax,
        }),
        Extension.create({
          name: "singleLineSearchBehavior",
          addKeyboardShortcuts() {
            return {
              Enter: () => true,
            }
          },
        }),
      ],
      immediatelyRender: false,
      onSelectionUpdate: ({ editor: nextEditor }) => {
        setCursor(getCursorOffset(nextEditor))
      },
      onUpdate: ({ editor: nextEditor }) => {
        const nextValue = getPlainText(nextEditor.state.doc)

        setCursor(getCursorOffset(nextEditor))

        if (nextValue !== valueRef.current) {
          if (submitRef.current) setActiveIndex(-1)
          onSearchChange(nextValue)
        }

        setOpen(true)
      },
    },
    []
  )

  // Flush controlled echoes before the next keystroke can advance the editor.
  React.useLayoutEffect(() => {
    valueRef.current = value
  }, [value])

  React.useEffect(() => {
    openRef.current = open
  }, [open])

  React.useEffect(() => {
    activeIndexRef.current = activeIndex
  }, [activeIndex])

  React.useEffect(() => {
    if (!editor || !onSubmit) return
    editor.view.dom.setAttribute("aria-autocomplete", "list")
    editor.view.dom.setAttribute("aria-haspopup", "listbox")
    editor.view.dom.setAttribute(
      "aria-expanded",
      String(open && suggestions.length > 0)
    )
    if (open && suggestions.length > 0)
      editor.view.dom.setAttribute("aria-controls", suggestionListId)
    else editor.view.dom.removeAttribute("aria-controls")
    if (activeIndex >= 0)
      editor.view.dom.setAttribute(
        "aria-activedescendant",
        `${suggestionListId}-${activeIndex}`
      )
    else editor.view.dom.removeAttribute("aria-activedescendant")
  }, [
    editor,
    onSubmit,
    open,
    suggestions.length,
    activeIndex,
    suggestionListId,
  ])

  React.useEffect(() => {
    latestSuggestionsRef.current = suggestions
  }, [suggestions])

  React.useEffect(() => {
    applySuggestionRef.current = applySuggestion
  }, [applySuggestion])

  React.useEffect(() => {
    itemRefs.current.length = suggestions.length
  }, [suggestions.length])

  React.useEffect(() => {
    if (!editor) {
      return
    }

    editor.view.dispatch(
      editor.state.tr.setMeta(selectorRefreshKey, { fields, syntax })
    )
  }, [editor, fields, syntax])

  React.useEffect(() => {
    if (!editor) return
    const extension = editor.extensionManager.extensions.find(
      (item) => item.name === "placeholder"
    )
    if (extension) extension.options.placeholder = placeholder
    editor.view.dispatch(
      editor.state.tr.setMeta("refresh-search-placeholder", true)
    )
  }, [editor, placeholder])

  React.useLayoutEffect(() => {
    if (!editor) {
      return
    }

    const nextSelection = pendingSelectionRef.current
    const editorValue = getPlainText(editor.state.doc)

    if (editorValue !== value) {
      syncEditorValue(editor, value, nextSelection ?? undefined)
    } else if (nextSelection) {
      editor.commands.setTextSelection({
        from: textOffsetToDocPosition(editor.state.doc, nextSelection.start),
        to: textOffsetToDocPosition(editor.state.doc, nextSelection.end),
      })
    }

    pendingSelectionRef.current = null
  }, [editor, syncEditorValue, value])

  React.useEffect(() => {
    if (!open || activeIndex < 0) {
      return
    }

    itemRefs.current[activeIndex]?.scrollIntoView({
      block: "nearest",
    })
  }, [activeIndex, open])

  React.useEffect(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (
        !containerRef.current?.contains(event.target as Node) &&
        !suggestionAnchorRef?.current?.contains(event.target as Node) &&
        !popupRef.current?.contains(event.target as Node)
      ) {
        setOpen(false)
      }
    }

    window.addEventListener("pointerdown", handlePointerDown)

    return () => window.removeEventListener("pointerdown", handlePointerDown)
  }, [setOpen, suggestionAnchorRef])

  React.useEffect(() => {
    if (!inputRef) {
      return
    }

    assignRefValue(inputRef, {
      focus: () => {
        editor?.commands.focus()
      },
      selectAll: () => {
        editor?.chain().focus().selectAll().run()
      },
    })

    return () => assignRefValue(inputRef, null)
  }, [editor, inputRef])

  const showLoading = isLoading
  const groupedSuggestions = [
    { items: inputSuggestions, label: undefined },
    { items: valueSuggestions, label: "Values" },
    { items: filterSuggestions, label: "Filters" },
  ] satisfies Array<{
    items: DataTableSearchSuggestion[]
    label?: string
  }>

  let flatIndex = 0

  return (
    <div
      ref={containerRef}
      className={
        embedded ? "relative min-w-28 flex-1" : "relative min-w-64 flex-1"
      }
      data-search-suggestions-open={
        open && suggestions.length > 0 ? "" : undefined
      }
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
          setOpen(false)
        }
      }}
    >
      {focused && !embedded && <div className="h-9" />}
      <div
        className={focused && !embedded ? "absolute inset-x-0 top-0 z-50" : ""}
        data-search-focused={focused ? "" : undefined}
      >
        <div
          className={
            embedded
              ? "flex min-h-7 w-full items-center"
              : `flex w-full items-start rounded-md border border-input/50 bg-background text-lg ring-offset-background focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 ${focused ? "min-h-9" : "h-9"}`
          }
        >
          {!embedded && (
            <div className="relative h-9 w-6 shrink-0 pl-1.5">
              <span
                aria-hidden="true"
                className="absolute inset-y-0 m-auto flex size-5 shrink-0 items-center justify-center"
              >
                <Search
                  className={cx(
                    "size-4.5",
                    showLoading && "animate-pulse duration-300"
                  )}
                />
              </span>
            </div>
          )}
          <div
            className={`relative min-w-0 flex-1 ${focused ? "" : "overflow-hidden"}`}
            title={showSummary ? value : undefined}
          >
            {showSummary ? (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 flex h-9 items-center gap-1.5 overflow-hidden px-2 text-sm"
              >
                {summary.map((item, index) => (
                  <span
                    key={index}
                    className="max-w-full min-w-0 shrink-0 truncate rounded bg-accent px-2 py-0.5 text-accent-foreground"
                  >
                    {item.label}
                  </span>
                ))}
              </div>
            ) : null}
            <EditorContent
              className={cx(showSummary ? "opacity-0" : undefined, "h-full")}
              editor={editor}
              onBlur={() => {
                requestAnimationFrame(() => {
                  if (!containerRef.current?.contains(document.activeElement)) {
                    setFocused(false)
                    setOpen(false)
                  }
                  suppressNextFocusOpenRef.current = false
                })
              }}
              onClick={() => {
                setCursor(editor ? getCursorOffset(editor) : 0)
                suppressNextFocusOpenRef.current = false
                setOpen(true)
              }}
              onFocus={() => {
                setFocused(true)
                setCursor(editor ? getCursorOffset(editor) : 0)

                if (suppressNextFocusOpenRef.current) {
                  suppressNextFocusOpenRef.current = false
                  return
                }

                setOpen(true)
              }}
            />
          </div>
          {!embedded && (
            <div className="flex h-9 shrink-0 items-center pr-1">
              {value ? (
                <button
                  aria-label="Clear search"
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  onClick={() => {
                    if (!editor) {
                      onSearchChange("")
                      setCursor(0)
                      setOpen(false)
                      return
                    }

                    pendingSelectionRef.current = { end: 0, start: 0 }
                    setCursor(0)
                    setOpen(false)
                    syncEditorValue(editor, "", pendingSelectionRef.current)
                    editor.commands.focus()
                    onSearchChange("")
                  }}
                  type="button"
                >
                  <XIcon className="pointer-events-none" />
                </button>
              ) : null}
            </div>
          )}
        </div>

        {open && (syntax !== "filter" || suggestions.length > 0) ? (
          <SuggestionPanel
            embedded={embedded}
            anchorRef={suggestionAnchorRef ?? containerRef}
            popupRef={popupRef}
            onOpenChange={setOpen}
          >
            <div className="flex max-h-[min(20rem,calc(100dvh_-_6rem),var(--radix-popover-content-available-height,20rem))] flex-col overflow-hidden rounded-lg bg-background text-popover-foreground shadow-md ring-1 ring-foreground/10">
              {suggestions.length === 0 ? (
                <div className="flex w-full justify-center py-2 text-center text-xs/relaxed text-muted-foreground">
                  No items found.
                </div>
              ) : (
                <div
                  role={onSubmit ? "listbox" : undefined}
                  id={suggestionListId}
                  aria-label={onSubmit ? "Filter suggestions" : undefined}
                  className="min-h-0 overflow-y-auto overscroll-contain p-1"
                >
                  {groupedSuggestions.map((group) => {
                    if (group.items.length === 0) {
                      return null
                    }

                    return (
                      <div key={group.label ?? "Input"}>
                        {group.label ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            {group.label}
                          </div>
                        ) : null}
                        {group.items.map((item) => {
                          const itemIndex = flatIndex

                          flatIndex += 1

                          return (
                            <button
                              key={item.id}
                              ref={(node) => {
                                itemRefs.current[itemIndex] = node
                              }}
                              type="button"
                              role={onSubmit ? "option" : undefined}
                              id={`${suggestionListId}-${itemIndex}`}
                              aria-selected={
                                onSubmit ? itemIndex === activeIndex : undefined
                              }
                              tabIndex={onSubmit ? -1 : undefined}
                              className={`relative flex min-h-7 w-full cursor-default items-center gap-2 rounded-md px-2 py-1 text-left text-xs/relaxed outline-hidden select-none hover:bg-accent hover:text-accent-foreground ${
                                itemIndex === activeIndex
                                  ? "bg-accent text-accent-foreground"
                                  : ""
                              }`}
                              data-highlighted={
                                itemIndex === activeIndex ? "" : undefined
                              }
                              onClick={() => applySuggestion(editor, item)}
                              onMouseDown={(event) => {
                                event.preventDefault()
                              }}
                              onMouseEnter={() =>
                                setActiveSuggestionIndex(itemIndex)
                              }
                            >
                              {item.id === "submit-fulltext" ||
                              (syntax === "search" &&
                                item.group === "input") ? (
                                <Search
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0 text-foreground-subtle"
                                />
                              ) : (
                                <ListFilter
                                  aria-hidden="true"
                                  className="size-3.5 shrink-0 text-foreground-subtle"
                                />
                              )}
                              <span className="min-w-0 truncate">
                                {item.id === "submit-fulltext" ? (
                                  item.label
                                ) : (
                                  <SyntaxCode
                                    text={item.label}
                                    language="filter"
                                    className="whitespace-pre"
                                  />
                                )}
                              </span>
                              {item.id.startsWith("submit-") ? (
                                <>
                                  <span className="shrink-0 text-foreground-muted">
                                    {item.id === "submit-fulltext"
                                      ? "Full-text search"
                                      : "Add filter"}
                                  </span>
                                  <CornerDownLeft className="ml-auto size-3.5 shrink-0 text-foreground-subtle" />
                                </>
                              ) : null}
                            </button>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </SuggestionPanel>
        ) : null}
      </div>
    </div>
  )
}

export const DataTableSearch = DataTableSearchInput
