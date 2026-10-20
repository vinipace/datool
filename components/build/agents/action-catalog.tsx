"use client"

import {
  Box,
  Braces,
  ClipboardList,
  FileInput,
  Headset,
  PanelsTopLeft,
  UsersRound,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import type { ActionDefinition } from "@/src/lib/build/contracts"
import { cn } from "@/lib/utils"
import type { ActionPreset } from "./action-presets"

const identities: Record<
  ActionPreset,
  { label: string; icon: LucideIcon; tone: string }
> = {
  integration: { label: "Connected app", icon: Box, tone: "text-action-api" },
  http: { label: "Call API", icon: Box, tone: "text-action-api" },
  client: { label: "Client event", icon: Braces, tone: "text-action-api" },
  handoff: { label: "Escalation", icon: Headset, tone: "text-action-handoff" },
  leads: {
    label: "Collect leads",
    icon: UsersRound,
    tone: "text-action-leads",
  },
  data: {
    label: "Collect data",
    icon: ClipboardList,
    tone: "text-action-form",
  },
  form: { label: "Form", icon: FileInput, tone: "text-action-form" },
  widget: { label: "Show Widget", icon: PanelsTopLeft, tone: "text-action-widget" },
}

const catalog: {
  id: ActionPreset
  title: string
  description: string
  actions: { preset: ActionPreset; label: string }[]
}[] = [
  { id: "integration", title: "Connected app", description: "Let your agent use apps such as Google Calendar through a connected account.", actions: [{ preset: "integration", label: "Use connected app" }] },
  {
    id: "handoff",
    title: "Escalations",
    description:
      "Bring in your team when a customer needs a human. Send the conversation to your inbox.",
    actions: [{ preset: "handoff", label: "Hand off to a team" }],
  },
  {
    id: "http",
    title: "Custom actions",
    description:
      "Call your API, run client-side code, or show an interactive widget in the conversation.",
    actions: [
      { preset: "http", label: "Call API" },
      { preset: "client", label: "Run client-side code" },
      { preset: "widget", label: "Show Widget" },
    ],
  },
  {
    id: "leads",
    title: "Collect leads",
    description:
      "Capture names, email addresses and phone numbers so your team can follow up.",
    actions: [{ preset: "leads", label: "Collect leads" }],
  },
  {
    id: "data",
    title: "Collect data",
    description:
      "Ask for the details you need, from order numbers to customer preferences.",
    actions: [{ preset: "data", label: "Collect data" }],
  },
  {
    id: "form",
    title: "Custom form",
    description:
      "Build a form with your own fields, required answers and a follow-up action.",
    actions: [{ preset: "form", label: "Create form" }],
  },
]

export function ActionIcon({
  type,
  size = "default",
}: {
  type: ActionPreset
  size?: "default" | "sm"
}) {
  const { icon: Icon, tone } = identities[type]
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-lg border border-border bg-background",
        size === "sm" ? "size-8" : "size-10",
        tone
      )}
    >
      <Icon className={size === "sm" ? "size-4" : "size-5"} />
    </span>
  )
}

export function ActionTypeLabel({ type }: { type: ActionDefinition["type"] }) {
  const { icon: Icon, label, tone } = identities[type]
  return (
    <span className="inline-flex items-center gap-2">
      <Icon aria-hidden className={cn("size-4 shrink-0", tone)} />
      {label}
    </span>
  )
}

export function ActionCatalog({
  onCreate,
}: {
  onCreate: (preset: ActionPreset) => void
}) {
  return (
    <section
      aria-label="Add an action"
      className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-3"
    >
      {catalog.map((category) => (
        <Card key={category.id} className="flex min-w-0 flex-col">
          <CardHeader className="gap-3">
            <ActionIcon type={category.id} />
            <div className="space-y-1.5">
              <CardTitle className="text-sm">{category.title}</CardTitle>
              <CardDescription className="leading-relaxed">
                {category.description}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="mt-auto flex flex-wrap gap-2 pt-4">
            {category.actions.map((action) => (
              <Button
                key={action.preset}
                type="button"
                size="sm"
                variant="outline"
                shape="circle"
                onClick={() => onCreate(action.preset)}
              >
                {action.label}
              </Button>
            ))}
          </CardContent>
        </Card>
      ))}
    </section>
  )
}
