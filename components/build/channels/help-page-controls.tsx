"use client"

import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { SettingsSection } from "@/components/ui/settings-section"
import { FormLabel } from "@/components/build/operations/build-page"
import type { HelpPageSettings } from "@/src/lib/build/chat-bubble"
import { isSafeHttpUrl } from "@/src/lib/build/urls"

type HelpLink = HelpPageSettings["links"][number]

function LinkFields({
  link,
  title,
  onChange,
  onRemove,
}: {
  link: HelpLink
  title: string
  onChange: (value: Partial<HelpLink>) => void
  onRemove: () => void
}) {
  const invalidUrl = !!link.url && !isSafeHttpUrl(link.url)
  return (
    <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{title}</p>
        <div className="flex items-center gap-2">
          <Switch
            aria-label={`Show ${title.toLowerCase()}`}
            checked={link.enabled !== false}
            onCheckedChange={(enabled) => onChange({ enabled })}
          />
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Remove ${title.toLowerCase()}`}
            onClick={onRemove}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </div>
      </div>
      <FormLabel label={`${title} label`}>
        <Input
          value={link.label}
          maxLength={120}
          onChange={(event) => onChange({ label: event.target.value })}
          placeholder={
            link.placement === "primary" ? "Dashboard" : "Contact us"
          }
        />
      </FormLabel>
      <FormLabel label={`${title} URL`}>
        <Input
          type="url"
          value={link.url}
          aria-invalid={invalidUrl || undefined}
          onChange={(event) => onChange({ url: event.target.value })}
          placeholder="https://example.com"
        />
        {invalidUrl ? (
          <p className="text-xs text-destructive">
            Enter a complete http:// or https:// link.
          </p>
        ) : null}
      </FormLabel>
      {link.placement === "card" ? (
        <FormLabel label={`${title} description`}>
          <Textarea
            value={link.description}
            rows={2}
            maxLength={300}
            onChange={(event) => onChange({ description: event.target.value })}
          />
        </FormLabel>
      ) : null}
    </div>
  )
}

export function HelpPageControls({
  settings,
  onChange,
}: {
  settings: HelpPageSettings
  onChange: (value: HelpPageSettings) => void
}) {
  function update<K extends keyof HelpPageSettings>(
    key: K,
    value: HelpPageSettings[K]
  ) {
    onChange({ ...settings, [key]: value })
  }
  function addLink(placement: HelpLink["placement"]) {
    update("links", [
      ...settings.links,
      {
        id: crypto.randomUUID(),
        label: "",
        url: "",
        description: "",
        placement,
        enabled: true,
      },
    ])
  }
  function fields(link: HelpLink, title: string) {
    return (
      <LinkFields
        key={link.id}
        link={link}
        title={title}
        onChange={(value) =>
          update(
            "links",
            settings.links.map((item) =>
              item.id === link.id ? { ...item, ...value } : item
            )
          )
        }
        onRemove={() =>
          update(
            "links",
            settings.links.filter((item) => item.id !== link.id)
          )
        }
      />
    )
  }
  const buttons = settings.links.filter((link) => link.placement !== "card")
  const cards = settings.links.filter((link) => link.placement === "card")
  const full = settings.links.length >= 12
  return (
    <>
      <SettingsSection title="General">
        <div className="space-y-5">
          <FormLabel label="Page title">
            <Input
              value={settings.pageTitle}
              maxLength={160}
              onChange={(event) => update("pageTitle", event.target.value)}
            />
          </FormLabel>
          <FormLabel label="Description">
            <Textarea
              value={settings.description}
              rows={2}
              maxLength={600}
              onChange={(event) => update("description", event.target.value)}
              placeholder="A short introduction to your help center"
            />
          </FormLabel>
          <FormLabel label="Favicon URL">
            <Input
              type="url"
              value={settings.faviconUrl ?? ""}
              onChange={(event) =>
                update("faviconUrl", event.target.value || null)
              }
              placeholder="https://example.com/favicon.png"
            />
          </FormLabel>
        </div>
      </SettingsSection>
      <SettingsSection title="Page layout">
        <div className="space-y-5">
          <FormLabel label="Sidebar logo URL">
            <Input
              type="url"
              value={settings.logoUrl ?? ""}
              onChange={(event) =>
                update("logoUrl", event.target.value || null)
              }
              placeholder="https://example.com/logo.png"
            />
          </FormLabel>
          <FormLabel
            label="Hero image URL"
            hint="Leave empty to use the agent avatar."
            hintPlacement="below"
          >
            <Input
              type="url"
              value={settings.heroImageUrl ?? ""}
              onChange={(event) =>
                update("heroImageUrl", event.target.value || null)
              }
              placeholder="https://example.com/hero.png"
            />
          </FormLabel>
          {(
            [
              ["showSidebar", "Show sidebar"],
              ["allowThemeSwitch", "Let visitors switch theme"],
              ["fieldGlow", "Message field glow"],
            ] as const
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center justify-between gap-4 text-sm"
            >
              <span>{label}</span>
              <Switch
                checked={settings[key]}
                onCheckedChange={(checked) => update(key, checked)}
              />
            </label>
          ))}
        </div>
      </SettingsSection>
      <SettingsSection title="Sidebar buttons">
        <div className="space-y-5">
          <p className="text-xs leading-5 text-foreground-muted">
            Add shortcuts above your visitors’ conversation history.
          </p>
          {buttons.map((link, index) =>
            fields(
              link,
              link.placement === "primary"
                ? "Primary button"
                : `Button ${index + 1}`
            )
          )}
          <div className="space-y-2">
            <Button
              type="button"
              variant="dashed"
              className="w-full justify-start"
              disabled={
                full || buttons.some((link) => link.placement === "primary")
              }
              onClick={() => addLink("primary")}
            >
              <Plus className="size-4" />
              Add primary button
            </Button>
            <Button
              type="button"
              variant="dashed"
              className="w-full justify-start"
              disabled={full}
              onClick={() => addLink("sidebar")}
            >
              <Plus className="size-4" />
              Add button
            </Button>
          </div>
          {full ? (
            <p className="text-xs text-foreground-muted">
              You can add up to 12 buttons and resource cards.
            </p>
          ) : null}
        </div>
      </SettingsSection>
      <SettingsSection title="Resource cards" defaultOpen={false}>
        <div className="space-y-5">
          {cards.map((link, index) => fields(link, `Resource ${index + 1}`))}
          <Button
            type="button"
            variant="dashed"
            className="w-full justify-start"
            disabled={full}
            onClick={() => addLink("card")}
          >
            <Plus className="size-4" />
            Add resource card
          </Button>
        </div>
      </SettingsSection>
    </>
  )
}
