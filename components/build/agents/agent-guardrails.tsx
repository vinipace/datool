"use client"

import * as React from "react"
import {
  Gauge,
  MessagesSquare,
  ShieldCheck,
  Wallet,
  type LucideIcon,
} from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { FormRow } from "@/components/ui/form-row"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import type { AgentConfiguration } from "@/src/lib/build/contracts"

type Guardrails = AgentConfiguration["guardrails"]

export function AgentGuardrails({
  configuration,
  onChange,
}: {
  configuration: AgentConfiguration
  onChange: (configuration: AgentConfiguration) => void
}) {
  const guardrails = configuration.guardrails
  function update<K extends keyof Guardrails>(key: K, value: Guardrails[K]) {
    onChange({
      ...configuration,
      guardrails: { ...guardrails, [key]: value },
    })
  }
  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-4 py-6 sm:px-6 sm:py-8">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight">Guardrails</h2>
        <p className="max-w-2xl text-sm leading-6 text-foreground-muted">
          Set boundaries for what your agent can answer, how much it can use,
          and when a teammate needs to step in.
        </p>
      </div>

      <GuardrailGroup
        title="Content & access"
        description="Choose which messages to block and when actions need approval."
        icon={ShieldCheck}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <GuardrailList
            id="guardrail-topics"
            label="Blocked topics"
            description="Block messages containing these words or phrases. One per line."
            placeholder={"Payment disputes\nAccount deletion"}
            values={guardrails.blockedTopics}
            onChange={(value) => update("blockedTopics", value)}
          />
          <GuardrailList
            id="guardrail-countries"
            label="Blocked countries"
            description="Two-letter country codes, one per line. Applied when the channel provides a country."
            placeholder={"BR\nUS"}
            values={guardrails.blockedCountries}
            countryCodes
            onChange={(value) => update("blockedCountries", value)}
          />
        </div>
        <div className="border-t border-border pt-5">
          <FormRow
            label="Require human approval for actions"
            htmlFor="guardrail-human"
            description="A teammate must approve actions before they run. Handoffs remain available."
            descriptionId="guardrail-human-help"
            controlWidth="auto"
            variant="plain"
          >
            <Switch
              id="guardrail-human"
              aria-describedby="guardrail-human-help"
              checked={guardrails.requireHumanForActions}
              onCheckedChange={(value) =>
                update("requireHumanForActions", value)
              }
            />
          </FormRow>
        </div>
      </GuardrailGroup>

      <GuardrailGroup
        title="Conversation limits"
        description="Keep individual messages, responses and conversations within bounds."
        icon={MessagesSquare}
      >
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          <GuardrailNumber
            id="guardrail-input"
            label="Input length"
            description="Characters per customer message."
            min={1}
            max={100000}
            value={guardrails.maxInputCharacters}
            onChange={(value) => update("maxInputCharacters", value!)}
          />
          <GuardrailNumber
            id="guardrail-output"
            label="Response length"
            description="Tokens per model response."
            min={1}
            max={64000}
            value={guardrails.maxOutputTokens}
            onChange={(value) => update("maxOutputTokens", value!)}
          />
          <GuardrailNumber
            id="guardrail-turns"
            label="Conversation length"
            description="Customer turns per conversation."
            min={1}
            max={200}
            value={guardrails.maxTurns}
            onChange={(value) => update("maxTurns", value!)}
          />
        </div>
      </GuardrailGroup>

      <GuardrailGroup
        title="Traffic & spam"
        description="Control incoming traffic across this agent’s channels."
        icon={Gauge}
      >
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3">
          <GuardrailNumber
            id="guardrail-rpm"
            label="Requests per minute"
            description="New turns in a rolling minute."
            min={1}
            max={100000}
            value={guardrails.requestsPerMinute}
            onChange={(value) => update("requestsPerMinute", value!)}
          />
          <GuardrailNumber
            id="guardrail-concurrency"
            label="Concurrent turns"
            description="AI turns running at the same time."
            min={1}
            max={1000}
            value={guardrails.maxConcurrentTurns}
            onChange={(value) => update("maxConcurrentTurns", value!)}
          />
          <GuardrailNumber
            id="guardrail-spam"
            label="Spam check interval"
            description="Check every N customer messages in a conversation. Leave empty to disable."
            min={2}
            max={100}
            value={guardrails.spamAfterMessages}
            optional
            placeholder="Disabled"
            onChange={(value) => update("spamAfterMessages", value)}
          />
        </div>
      </GuardrailGroup>

      <GuardrailGroup
        title="Daily limits"
        description="Set a daily allowance for this agent. Both limits reset at 00:00 UTC."
        icon={Wallet}
      >
        <div className="grid gap-5 sm:grid-cols-2">
          <GuardrailNumber
            id="guardrail-daily-turns"
            label="Daily turns"
            description="Across all channels. Leave empty for no daily turn limit."
            min={1}
            max={10000000}
            value={guardrails.dailyTurnLimit}
            optional
            placeholder="No limit"
            onChange={(value) => update("dailyTurnLimit", value)}
          />
          <GuardrailNumber
            id="guardrail-budget"
            label="Daily budget (USD)"
            description="Tracked model spend. Leave empty for no daily budget."
            min={0}
            max={1000000}
            step={0.01}
            value={guardrails.dailyBudgetUsd}
            optional
            placeholder="No limit"
            onChange={(value) => update("dailyBudgetUsd", value)}
          />
        </div>
      </GuardrailGroup>
    </div>
  )
}

function GuardrailGroup({
  title,
  description,
  icon: Icon,
  children,
}: React.PropsWithChildren<{
  title: string
  description: string
  icon: LucideIcon
}>) {
  const id = React.useId()
  return (
    <section
      aria-labelledby={id}
      className="grid gap-4 lg:grid-cols-[12rem_minmax(0,1fr)] lg:gap-8"
    >
      <div className="space-y-2">
        <h3 id={id} className="flex items-center gap-2 text-sm font-medium">
          <Icon aria-hidden className="size-4 shrink-0 text-foreground-muted" />
          {title}
        </h3>
        <p className="text-xs leading-5 text-foreground-muted">{description}</p>
      </div>
      <Card>
        <CardContent className="space-y-5 p-4 sm:p-5">{children}</CardContent>
      </Card>
    </section>
  )
}

function GuardrailNumber({
  id,
  label,
  description,
  value,
  min,
  max,
  step = 1,
  optional = false,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  description: string
  value: number | null
  min: number
  max: number
  step?: number
  optional?: boolean
  placeholder?: string
  onChange: (value: number | null) => void
}) {
  const invalid =
    value !== null &&
    (!Number.isFinite(value) ||
      value < min ||
      value > max ||
      (step === 1 && !Number.isInteger(value)))
  const helpId = `${id}-help`
  const errorId = `${id}-error`
  return (
    <FormRow
      label={`${label}${optional ? " (optional)" : ""}`}
      htmlFor={id}
      description={description}
      descriptionId={helpId}
      layout="vertical"
      variant="plain"
    >
      <Input
        id={id}
        type="number"
        min={min}
        max={max}
        step={step}
        required={!optional}
        value={value ?? ""}
        placeholder={placeholder}
        invalid={invalid}
        aria-describedby={`${helpId}${invalid ? ` ${errorId}` : ""}`}
        onChange={(event) =>
          onChange(
            event.target.value === "" && optional
              ? null
              : Number(event.target.value)
          )
        }
      />
      {invalid ? (
        <p id={errorId} role="alert" className="mt-2 text-xs text-destructive">
          Enter {step === 1 ? "a whole number" : "an amount"} from{" "}
          {min.toLocaleString()} to {max.toLocaleString()}.
        </p>
      ) : null}
    </FormRow>
  )
}

function GuardrailList({
  id,
  label,
  description,
  placeholder,
  values,
  countryCodes = false,
  onChange,
}: {
  id: string
  label: string
  description: string
  placeholder: string
  values: string[]
  countryCodes?: boolean
  onChange: (values: string[]) => void
}) {
  const source = values.join("\n")
  const [draft, setDraft] = React.useState({ source, text: source })
  if (draft.source !== source) setDraft({ source, text: source })
  return (
    <FormRow
      label={label}
      htmlFor={id}
      description={description}
      descriptionId={`${id}-help`}
      layout="vertical"
      variant="plain"
    >
      <Textarea
        id={id}
        aria-describedby={`${id}-help`}
        rows={3}
        placeholder={placeholder}
        value={draft.text}
        onChange={(event) => {
          const text = event.target.value
          const next = text
            .split("\n")
            .map((item) => {
              const value = item.trim()
              return countryCodes ? value.toUpperCase() : value
            })
            .filter(Boolean)
          setDraft({ source: next.join("\n"), text })
          onChange(next)
        }}
      />
    </FormRow>
  )
}
