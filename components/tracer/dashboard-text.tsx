"use client"

import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import {
  RichTextEditor,
  richTextClassName,
} from "@/components/ui/rich-text-editor"
import type { WidgetControls } from "@/components/ui/canvas"
import type { DashboardWidgetProps } from "./dashboard-canvas-layout"

export function DashboardText({
  widget,
  editable,
  onPropsChange,
}: DashboardWidgetProps & WidgetControls<DashboardWidgetProps>) {
  if (widget.type !== "text") return null
  return (
    <div className="py-2">
      {editable ? (
        <RichTextEditor
          label={`${widget.title} content`}
          value={widget.content}
          onChange={(content) =>
            onPropsChange({ widget: { ...widget, content } })
          }
        />
      ) : (
        <div className={richTextClassName}>
          {widget.content ? (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              skipHtml
              components={{ img: ({ alt }) => <span>{alt}</span> }}
            >
              {widget.content}
            </ReactMarkdown>
          ) : (
            <p className="text-foreground-muted">
              Add text, notes or conclusions.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
