"use client"

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Extension, type Editor } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus"
import { Plugin } from "@tiptap/pm/state"
import StarterKit from "@tiptap/starter-kit"
import { Markdown } from "@tiptap/markdown"
import Placeholder from "@tiptap/extension-placeholder"
import { Bold, Italic, Heading2, List, ListOrdered, Quote } from "lucide-react"
import { Button } from "./button"
import type { ComboboxOption } from "./combobox"
import { Popover, PopoverAnchor, PopoverContent } from "./popover"
import { cn } from "@/lib/utils"

export const richTextClassName =
  "text-sm break-words whitespace-normal [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:text-lg [&_h3]:font-medium [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-auto [&_pre]:rounded-md [&_pre]:bg-background [&_pre]:p-3 [&_table]:w-full [&_td]:p-2 [&_th]:p-2 [&_ul]:list-disc [&_ul]:pl-5"

const bubbleMenuOptions: BubbleMenuProps["options"] = {
  placement: "top",
  strategy: "fixed",
  offset: 8,
  shift: { padding: 8 },
  hide: true,
}
const appendMenuToBody = () => document.body

/** Inline TipTap editing with Markdown persistence shared by dashboard/report text. */
export function RichTextEditor({
  value,
  onChange,
  label,
  maxLength = 20000,
  id,
  variant = "inline",
  disabled = false,
  mentions,
  mentionEmptyLabel = "No matching actions.",
  placeholder = "Write notes, context, or conclusions…",
}: {
  value: string
  onChange: (value: string) => void
  label: string
  maxLength?: number
  id?: string
  variant?: "inline" | "field"
  disabled?: boolean
  mentions?: ComboboxOption[]
  mentionEmptyLabel?: string
  placeholder?: string
}) {
  const menuRef = useRef<HTMLDivElement>(null)
  const mentionId = useId()
  const [mention, setMention] = useState<{
    from: number
    to: number
    query: string
  } | null>(null)
  const [highlighted, setHighlighted] = useState(0)
  const matches = (mentions ?? []).filter((option) =>
    [option.label, ...(option.keywords ?? [])].some((text) =>
      text.toLowerCase().includes(mention?.query.toLowerCase() ?? "")
    )
  )
  const enabledMatches = matches.filter((option) => !option.disabled)
  const activeMention = enabledMatches[highlighted] ?? enabledMatches[0]

  function updateMention(editor: Editor) {
    if (
      !mentions ||
      disabled ||
      !editor.state.selection.empty ||
      editor.isActive("codeBlock") ||
      editor.isActive("code")
    ) {
      setMention(null)
      return
    }
    const { $from, from } = editor.state.selection
    const before = $from.parent.textBetween(0, $from.parentOffset, "\n", "\n")
    const match = before.match(/(?:^|[\s(])@([\p{L}\p{N}_ -]{0,80})$/u)
    const start = from - (match?.[1].length ?? 0) - 1
    if (
      !match ||
      editor.state.doc.rangeHasMark(start, from, editor.schema.marks.link)
    ) {
      setMention(null)
      return
    }
    setMention({ from: start, to: from, query: match[1] })
    setHighlighted(0)
  }
  function insertMention(editor: Editor, option: ComboboxOption) {
    if (!mention || option.disabled) return
    editor
      .chain()
      .focus()
      .insertContentAt({ from: mention.from, to: mention.to }, [
        {
          type: "text",
          text: `@${option.label}`,
          marks: [{ type: "link", attrs: { href: `action:${option.value}` } }],
        },
        { type: "text", text: " ", marks: [] },
      ])
      .run()
    setMention(null)
  }
  const limit = useMemo(
    () =>
      Extension.create({
        name: "markdownLengthLimit",
        addProseMirrorPlugins() {
          const editor = this.editor
          return [
            new Plugin({
              filterTransaction(transaction) {
                return (
                  !transaction.docChanged ||
                  (editor.markdown?.serialize(transaction.doc.toJSON())
                    .length ?? 0) <= maxLength
                )
              },
            }),
          ]
        },
      }),
    [maxLength]
  )
  const editor: Editor | null = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: {
          openOnClick: false,
          ...(mentions ? { protocols: ["action"] } : {}),
        },
      }),
      Markdown,
      Placeholder.configure({
        placeholder,
      }),
      limit,
    ],
    content: value,
    contentType: "markdown",
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": label,
        "aria-multiline": "true",
        ...(id ? { id } : {}),
        ...(mentions
          ? {
              "aria-autocomplete": "list",
              "aria-controls": mentionId,
              "aria-activedescendant":
                mention && activeMention
                  ? `${mentionId}-${activeMention.value}`
                  : "",
            }
          : {}),
        class: cn(
          richTextClassName,
          "min-h-8 border-0 outline-none [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-foreground-muted [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]",
          variant === "field" &&
            "max-h-[32rem] min-h-64 overflow-y-auto rounded-md border border-border bg-input-background px-3 py-2 focus-visible:ring-2 focus-visible:ring-ring",
          mentions &&
            "[&_a[href^='action:']]:rounded [&_a[href^='action:']]:bg-selection [&_a[href^='action:']]:px-1 [&_a[href^='action:']]:text-selection-foreground [&_a[href^='action:']]:no-underline",
          disabled && "cursor-not-allowed opacity-50"
        ),
      },
      handleKeyDown: (_view, event) => {
        if (!mention || !editor) return false
        if (event.key === "Escape") {
          event.preventDefault()
          setMention(null)
          return true
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault()
          const direction = event.key === "ArrowDown" ? 1 : -1
          setHighlighted((index) =>
            enabledMatches.length
              ? (index + direction + enabledMatches.length) %
                enabledMatches.length
              : 0
          )
          return true
        }
        if ((event.key === "Enter" || event.key === "Tab") && activeMention) {
          event.preventDefault()
          insertMention(editor, activeMention)
          return true
        }
        return false
      },
    },
    onUpdate: ({ editor }) => {
      onChange(editor.getMarkdown())
      updateMention(editor)
    },
    onSelectionUpdate: ({ editor }) => updateMention(editor),
    onBlur: ({ editor, event }) => {
      // BubbleMenu is portaled outside the canvas; only its own controls
      // should keep the selection menu open when the editor loses focus.
      if (!menuRef.current?.contains(event.relatedTarget as Node | null))
        editor.commands.setMeta("textFormatting", "hide")
    },
  })
  const mentionAnchor = {
    current: {
      getBoundingClientRect: () => {
        if (!editor || !mention) return new DOMRect()
        const rect = editor.view.coordsAtPos(mention.to)
        return new DOMRect(rect.left, rect.top, 1, rect.bottom - rect.top)
      },
    },
  }
  useEffect(() => {
    if (editor && editor.getMarkdown() !== value)
      editor.commands.setContent(value, {
        contentType: "markdown",
        emitUpdate: false,
      })
  }, [editor, value])
  useEffect(() => {
    if (!editor) return
    // The canvas scrolls independently of the window. Keep the portaled menu
    // anchored to its selection when any editor ancestor scrolls.
    const reposition = (event: Event) => {
      if (
        !editor.isDestroyed &&
        !editor.state.selection.empty &&
        event.target instanceof Node &&
        event.target.contains(editor.view.dom)
      )
        editor.commands.setMeta("textFormatting", "updatePosition")
    }
    document.addEventListener("scroll", reposition, true)
    return () => document.removeEventListener("scroll", reposition, true)
  }, [editor])
  const actions = editor
    ? [
        {
          label: "Bold",
          icon: Bold,
          active: editor.isActive("bold"),
          run: () => editor.chain().focus().toggleBold().run(),
        },
        {
          label: "Italic",
          icon: Italic,
          active: editor.isActive("italic"),
          run: () => editor.chain().focus().toggleItalic().run(),
        },
        {
          label: "Heading",
          icon: Heading2,
          active: editor.isActive("heading", { level: 2 }),
          run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
        },
        {
          label: "Bullet list",
          icon: List,
          active: editor.isActive("bulletList"),
          run: () => editor.chain().focus().toggleBulletList().run(),
        },
        {
          label: "Numbered list",
          icon: ListOrdered,
          active: editor.isActive("orderedList"),
          run: () => editor.chain().focus().toggleOrderedList().run(),
        },
        {
          label: "Quote",
          icon: Quote,
          active: editor.isActive("blockquote"),
          run: () => editor.chain().focus().toggleBlockquote().run(),
        },
      ]
    : []
  return (
    <div data-canvas-no-drag className="min-w-0">
      {editor && (
        <BubbleMenu
          ref={menuRef}
          editor={editor}
          pluginKey="textFormatting"
          appendTo={appendMenuToBody}
          options={bubbleMenuOptions}
          role="group"
          aria-label={`${label} formatting`}
          className="z-50 flex gap-1 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {actions.map((action) => (
            <Button
              key={action.label}
              type="button"
              size="icon-sm"
              variant={action.active ? "secondary" : "ghost-muted"}
              aria-label={action.label}
              aria-pressed={action.active}
              onMouseDown={(event) => event.preventDefault()}
              onClick={action.run}
            >
              <action.icon className="size-4" />
            </Button>
          ))}
        </BubbleMenu>
      )}
      {mentions ? (
        <Popover
          open={Boolean(mention)}
          onOpenChange={(open) => {
            if (!open) setMention(null)
          }}
        >
          <PopoverAnchor virtualRef={mentionAnchor} />
          <EditorContent editor={editor} />
          <PopoverContent
            role="presentation"
            className="max-h-64 overflow-auto p-1"
            onOpenAutoFocus={(event) => event.preventDefault()}
            onCloseAutoFocus={(event) => event.preventDefault()}
            onInteractOutside={(event) => {
              if (
                event.target instanceof Node &&
                editor?.view.dom.contains(event.target)
              )
                event.preventDefault()
            }}
          >
            <div id={mentionId} role="listbox" aria-label="Actions">
              {matches.length ? (
                matches.map((option) => {
                  const Icon = option.icon
                  return (
                    <Button
                      key={option.value}
                      id={`${mentionId}-${option.value}`}
                      type="button"
                      role="option"
                      aria-selected={activeMention?.value === option.value}
                      variant={
                        activeMention?.value === option.value
                          ? "secondary"
                          : "ghost"
                      }
                      disabled={option.disabled}
                      className="h-auto w-full justify-start px-2 py-2 text-left whitespace-normal"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        if (editor) insertMention(editor, option)
                      }}
                    >
                      {Icon ? (
                        <Icon className="size-4 shrink-0" aria-hidden />
                      ) : null}
                      <span className="min-w-0">
                        <span className="block text-sm">{option.label}</span>
                        {option.description ? (
                          <span className="mt-1 block text-xs font-normal text-foreground-muted">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </Button>
                  )
                })
              ) : (
                <p className="p-3 text-xs text-foreground-muted">
                  {mentionEmptyLabel}
                </p>
              )}
            </div>
          </PopoverContent>
        </Popover>
      ) : (
        <EditorContent editor={editor} />
      )}
    </div>
  )
}
