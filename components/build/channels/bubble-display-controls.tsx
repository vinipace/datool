"use client"

import * as React from "react"
import { ImagePlus } from "lucide-react"
import { RadioCard } from "@/components/ui/radio-card"
import { ChoiceCard } from "@/components/ui/choice-card"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { FormLabel } from "@/components/build/operations/build-page"
import { BubbleLauncherIcon } from "@/components/build/chat/bubble-launcher-icon"
import { bubbleRadii } from "@/components/build/chat/bubble-style"
import { bubbleLanguages } from "@/src/lib/build/bubble-localization"
import type {
  BubbleLanguage,
  ChatBubbleSettings,
} from "@/src/lib/build/chat-bubble"

export function BubbleRadiusPicker({
  value,
  onChange,
}: {
  value: ChatBubbleSettings["radius"]
  onChange: (value: ChatBubbleSettings["radius"]) => void
}) {
  const name = React.useId()
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Corner radius</legend>
      <div className="grid grid-cols-4 gap-2">
        {(["square", "small", "medium", "large"] as const).map((radius) => (
          <RadioCard
            key={radius}
            compact
            name={name}
            value={radius}
            aria-label={`${radius} corners`}
            checked={value === radius}
            onChange={() => onChange(radius)}
          >
            <span className="flex flex-col items-center gap-3">
              <span
                className="size-8 border-t-2 border-l-2 border-current"
                style={{ borderTopLeftRadius: bubbleRadii[radius] }}
                aria-hidden
              />
              <span className="text-xs capitalize">{radius}</span>
            </span>
          </RadioCard>
        ))}
      </div>
    </fieldset>
  )
}

export function BubblePositionPicker({
  value,
  onChange,
}: {
  value: ChatBubbleSettings["position"]
  onChange: (value: ChatBubbleSettings["position"]) => void
}) {
  const name = React.useId()
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Position</legend>
      <div className="grid grid-cols-2 gap-3">
        {(["left", "right"] as const).map((position) => (
          <RadioCard
            compact
            key={position}
            name={name}
            value={position}
            aria-label={`Bottom ${position}`}
            checked={value === position}
            onChange={() => onChange(position)}
          >
            <span className="flex flex-col items-center gap-3">
              <span
                className={`flex h-24 w-full flex-col justify-end gap-2 rounded-md border border-border bg-muted p-3 ${position === "left" ? "items-start" : "items-end"}`}
                aria-hidden
              >
                <span className="h-12 w-9 rounded border border-current bg-background" />
                <span className="size-3 rounded-full bg-current" />
              </span>
              <span className="text-sm capitalize">{position}</span>
            </span>
          </RadioCard>
        ))}
      </div>
    </fieldset>
  )
}

export function BubbleIconPicker({
  settings,
  onChange,
}: {
  settings: ChatBubbleSettings
  onChange: (value: ChatBubbleSettings["launcherIcon"]) => void
}) {
  const name = React.useId()
  return (
    <fieldset className="space-y-3">
      <legend className="text-sm font-medium">Bubble icon</legend>
      <div className="grid grid-cols-4 gap-2">
        {(["chat", "sparkles", "headset", "custom"] as const).map((icon) => (
          <RadioCard
            compact
            key={icon}
            name={name}
            value={icon}
            aria-label={`${icon} bubble icon`}
            checked={settings.launcherIcon === icon}
            onChange={() => onChange(icon)}
          >
            <span className="flex flex-col items-center gap-2">
              {icon === "custom" && !settings.launcherIconUrl ? (
                <ImagePlus className="size-6" />
              ) : (
                <BubbleLauncherIcon
                  settings={{ ...settings, launcherIcon: icon }}
                />
              )}
              <span className="text-xs capitalize">{icon}</span>
            </span>
          </RadioCard>
        ))}
      </div>
    </fieldset>
  )
}

export function BubbleLocalization({
  settings,
  onChange,
}: {
  settings: ChatBubbleSettings
  onChange: (value: ChatBubbleSettings["localization"]) => void
}) {
  const config = settings.localization
  const [editingLanguage, setEditingLanguage] = React.useState<BubbleLanguage>(
    config.defaultLanguage
  )
  const language = config.languages.includes(editingLanguage)
    ? editingLanguage
    : config.defaultLanguage
  const content = config.translations[language] ?? {}
  function translate(
    key: "welcomeMessage" | "inputPlaceholder" | "launcherLabel",
    value: string
  ) {
    onChange({
      ...config,
      translations: {
        ...config.translations,
        [language]: { ...content, [key]: value || undefined },
      },
    })
  }
  return (
    <div className="space-y-5">
      <FormLabel label="Language source">
        <Select
          value={config.source}
          onChange={(event) =>
            onChange({
              ...config,
              source: event.target.value as "browser" | "fixed",
            })
          }
        >
          <option value="browser">Visitor’s browser</option>
          <option value="fixed">Default language</option>
        </Select>
      </FormLabel>
      <FormLabel label="Default language">
        <Select
          value={config.defaultLanguage}
          onChange={(event) => {
            const next = event.target.value as BubbleLanguage
            onChange({
              ...config,
              defaultLanguage: next,
              languages: [...new Set([...config.languages, next])],
            })
          }}
        >
          {bubbleLanguages.map((item) => (
            <option key={item.value} value={item.value}>
              {item.label}
            </option>
          ))}
        </Select>
      </FormLabel>
      <fieldset className="space-y-3">
        <legend className="text-sm font-medium">Enabled languages</legend>
        <p className="text-xs leading-5 text-foreground-muted">
          Use the visitor’s language when enabled. Otherwise, use the default.
        </p>
        <div className="space-y-2">
          {bubbleLanguages.map((item) => (
            <ChoiceCard
              type="checkbox"
              key={item.value}
              checked={config.languages.includes(item.value)}
              disabled={item.value === config.defaultLanguage}
              onChange={(event) =>
                onChange({
                  ...config,
                  languages: event.target.checked
                    ? [...config.languages, item.value]
                    : config.languages.filter((value) => value !== item.value),
                })
              }
            >
              {item.label}
              {item.value === config.defaultLanguage ? " · Default" : ""}
            </ChoiceCard>
          ))}
        </div>
      </fieldset>
      <div className="space-y-4 rounded-lg border border-border bg-muted/30 p-4">
        <FormLabel label="Translate content">
          <Select
            value={language}
            onChange={(event) =>
              setEditingLanguage(event.target.value as BubbleLanguage)
            }
          >
            {bubbleLanguages
              .filter((item) => config.languages.includes(item.value))
              .map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
          </Select>
        </FormLabel>
        <p className="text-xs leading-5 text-foreground-muted">
          Interface labels are translated automatically. Leave these fields
          empty to use your shared content. Response language follows the
          agent’s instructions.
        </p>
        <FormLabel label="Translated welcome message">
          <Textarea
            rows={3}
            value={content.welcomeMessage ?? ""}
            placeholder={settings.welcomeMessage}
            onChange={(event) =>
              translate("welcomeMessage", event.target.value)
            }
          />
        </FormLabel>
        <FormLabel label="Translated input placeholder">
          <Input
            value={content.inputPlaceholder ?? ""}
            placeholder="Use the language default"
            onChange={(event) =>
              translate("inputPlaceholder", event.target.value)
            }
          />
        </FormLabel>
        {settings.layout !== "help_page" ? (
          <FormLabel label="Translated launcher label">
            <Input
              value={content.launcherLabel ?? ""}
              placeholder={settings.launcherLabel}
              onChange={(event) =>
                translate("launcherLabel", event.target.value)
              }
            />
          </FormLabel>
        ) : null}
        <FormLabel
          label="Translated suggested replies"
          hint="One per line."
          hintPlacement="below"
        >
          <Textarea
            rows={3}
            value={content.suggestedReplies?.join("\n") ?? ""}
            onChange={(event) =>
              onChange({
                ...config,
                translations: {
                  ...config.translations,
                  [language]: {
                    ...content,
                    suggestedReplies: event.target.value
                      ? event.target.value.split("\n")
                      : undefined,
                  },
                },
              })
            }
          />
        </FormLabel>
      </div>
    </div>
  )
}
