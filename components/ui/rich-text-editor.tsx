"use client"

import { useEffect, useMemo, useRef } from "react"
import { Extension } from "@tiptap/core"
import { EditorContent, useEditor } from "@tiptap/react"
import { BubbleMenu, type BubbleMenuProps } from "@tiptap/react/menus"
import { Plugin } from "@tiptap/pm/state"
import StarterKit from "@tiptap/starter-kit"
import { Markdown } from "@tiptap/markdown"
import Placeholder from "@tiptap/extension-placeholder"
import { Bold, Italic, Heading2, List, ListOrdered, Quote } from "lucide-react"
import { Button } from "./button"

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
}: {
  value: string
  onChange: (value: string) => void
  label: string
  maxLength?: number
}) {
  const menuRef = useRef<HTMLDivElement>(null)
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
  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: true,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        link: { openOnClick: false },
      }),
      Markdown,
      Placeholder.configure({
        placeholder: "Write notes, context, or conclusions…",
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
        class: `${richTextClassName} min-h-8 border-0 outline-none [&_p.is-editor-empty:first-child]:before:pointer-events-none [&_p.is-editor-empty:first-child]:before:float-left [&_p.is-editor-empty:first-child]:before:h-0 [&_p.is-editor-empty:first-child]:before:text-foreground-muted [&_p.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]`,
      },
    },
    onUpdate: ({ editor }) => onChange(editor.getMarkdown()),
    onBlur: ({ editor, event }) => {
      // BubbleMenu is portaled outside the canvas; only its own controls
      // should keep the selection menu open when the editor loses focus.
      if (!menuRef.current?.contains(event.relatedTarget as Node | null))
        editor.commands.setMeta("textFormatting", "hide")
    },
  })
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
      <EditorContent editor={editor} />
    </div>
  )
}
