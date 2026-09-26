"use client"

import type { ReactNode } from "react"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "./button"
import { CodeEditor } from "./code-editor"
import { InspectorSection } from "./inspector-section"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./base-select"

type Message<Role extends string> = { role: Role; content: string }

/** Shared message authoring; callers own supported roles and resource limits. */
export function MessagesForm<Role extends string>({
  messages,
  onChange,
  roles,
  defaultRole,
  description,
  language = "mustache",
  minMessages = 1,
  maxMessages,
  disabled = false,
}: {
  messages: Message<Role>[]
  onChange: (messages: Message<Role>[]) => void
  roles: readonly { value: Role; label: string }[]
  defaultRole: Role
  description?: ReactNode
  language?: "mustache" | "plaintext"
  minMessages?: number
  maxMessages: number
  disabled?: boolean
}) {
  function update(index: number, patch: Partial<Message<Role>>) {
    if (disabled) return
    onChange(
      messages.map((message, i) =>
        i === index ? { ...message, ...patch } : message
      )
    )
  }

  return (
    <InspectorSection label="Messages" variant="form">
      {description && (
        <p className="mt-1 text-xs text-foreground-muted">{description}</p>
      )}
      {messages.map((message, index) => (
        <div key={index} className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <Select
              items={roles}
              value={message.role}
              disabled={disabled}
              onValueChange={(value) => {
                const role = roles.find((role) => role.value === value)
                if (role) update(index, { role: role.value })
              }}
            >
              <SelectTrigger
                size="sm"
                variant="ghost"
                aria-label={`Message ${index + 1} role`}
                className="-mx-1 gap-1 px-1 text-foreground-muted"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent alignItemWithTrigger={false}>
                {roles.map((role) => (
                  <SelectItem key={role.value} value={role.value}>
                    {role.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {index >= minMessages && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove message ${index + 1}`}
                disabled={disabled}
                onClick={() => onChange(messages.filter((_, i) => i !== index))}
              >
                <Trash2 className="size-3.5" />
              </Button>
            )}
          </div>
          <CodeEditor
            label={`Message ${index + 1}`}
            language={language}
            lineNumbers={false}
            autoSize
            className="mt-1"
            readOnly={disabled}
            value={message.content}
            onChange={(content) => update(index, { content })}
          />
        </div>
      ))}
      <Button
        type="button"
        className="mt-3 -ml-2"
        variant="ghost-muted"
        size="sm"
        disabled={disabled || messages.length >= maxMessages}
        onClick={() =>
          onChange([...messages, { role: defaultRole, content: "" }])
        }
      >
        <Plus className="size-3.5" />
        Message
      </Button>
    </InspectorSection>
  )
}
