"use client"

import { useCallback, useId, useRef, useState } from "react"
import { Languages, Plus } from "lucide-react"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { bubbleLanguages } from "@/src/lib/build/bubble-localization"
import type { WidgetTranslations } from "@/src/lib/build/widget-i18n"

export function WidgetTranslationsEditor({
  translations = {},
  textKeys = [],
  onChange,
}: {
  translations?: WidgetTranslations
  textKeys?: string[]
  onChange: (value: WidgetTranslations) => void
}) {
  const [language, setLanguage] = useState("pt-BR")
  const [adding, setAdding] = useState(false)
  const [newKey, setNewKey] = useState("")
  const addButton = useRef<HTMLButtonElement>(null)
  const focusNewText = useCallback(
    (node: HTMLInputElement | null) => node?.focus(),
    []
  )
  const errorId = useId()
  const keys = [
    ...new Set([
      ...textKeys,
      ...Object.values(translations).flatMap(Object.keys),
    ]),
  ].filter(Boolean)
  const languageLabel = bubbleLanguages.find(
    (item) => item.value === language
  )!.label
  const translated = keys.filter((key) => translations[language]?.[key]).length
  const duplicate = keys.includes(newKey.trim())
  function translate(key: string, value: string) {
    onChange({
      ...translations,
      [language]: { ...translations[language], [key]: value },
    })
  }
  function closeAdd() {
    setAdding(false)
    setNewKey("")
    addButton.current?.focus()
  }
  function addText() {
    if (!newKey.trim() || duplicate) return
    translate(newKey.trim(), "")
    closeAdd()
  }
  return (
    <div className="@container/translations min-w-0 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Languages
            className="size-4 shrink-0 text-foreground-muted"
            aria-hidden
          />
          <Select
            aria-label="Translation language"
            className="w-auto max-w-full"
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
          >
            {bubbleLanguages.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </div>
        <span className="text-xs text-foreground-muted" role="status">
          {translated} of {keys.length} translated
          {keys.length > translated && ` · ${keys.length - translated} missing`}
        </span>
      </div>

      {keys.length ? (
        <div className="overflow-hidden rounded-lg border border-border">
          <div className="hidden grid-cols-2 gap-4 border-b border-border bg-muted px-3 py-2 text-xs font-medium text-foreground-muted @md/translations:grid">
            <span>Original text</span>
            <span>{languageLabel}</span>
          </div>
          <div className="divide-y divide-border">
            {keys.map((key) => (
              <div
                key={key}
                className="grid min-w-0 gap-2 bg-surface-row px-3 py-3 @md/translations:grid-cols-2 @md/translations:items-start @md/translations:gap-4"
              >
                <div className="min-w-0 text-sm @md/translations:py-2">
                  <p className="mb-1 text-xs text-foreground-muted @md/translations:hidden">
                    Original text
                  </p>
                  <p className="[overflow-wrap:anywhere] whitespace-pre-wrap">
                    {key}
                  </p>
                </div>
                <Textarea
                  aria-label={`${languageLabel} translation for ${key}`}
                  lang={language}
                  autoSize
                  rows={1}
                  maxLength={4000}
                  value={translations[language]?.[key] ?? ""}
                  placeholder="Enter translation…"
                  onChange={(event) => translate(key, event.target.value)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center">
          <p className="text-sm font-medium">No text to translate yet</p>
          <p className="mt-1 text-xs text-foreground-muted">
            Add a title, label or message from your widget.
          </p>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          ref={addButton}
          type="button"
          variant="outline"
          size="sm"
          aria-expanded={adding}
          onClick={() => setAdding(!adding)}
        >
          <Plus aria-hidden />
          Add text
        </Button>
        <p className="text-xs text-foreground-muted">
          Empty translations use the original text.
        </p>
      </div>
      {adding && (
        <div className="space-y-2 rounded-lg border border-border bg-muted p-3">
          <label className="block space-y-2 text-sm">
            <span>Original text</span>
            <Input
              ref={focusNewText}
              placeholder="e.g. Request demo"
              maxLength={4000}
              value={newKey}
              invalid={duplicate}
              aria-describedby={duplicate ? errorId : undefined}
              onChange={(event) => setNewKey(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault()
                  addText()
                }
                if (event.key === "Escape") {
                  event.preventDefault()
                  event.stopPropagation()
                  closeAdd()
                }
              }}
            />
          </label>
          {duplicate && (
            <p id={errorId} className="text-xs text-destructive">
              This text is already in the list.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={closeAdd}>
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!newKey.trim() || duplicate}
              onClick={addText}
            >
              Add
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
