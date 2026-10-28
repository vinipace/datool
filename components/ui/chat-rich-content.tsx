"use client"

import * as React from "react"
import { Check } from "lucide-react"
import { cn } from "@/lib/utils"
import { Button } from "./button"
import { Checkbox } from "./checkbox"
import { Input } from "./input"
import { Select } from "./select"
import { Textarea } from "./textarea"
import type { InspectorMessage } from "@/src/lib/tracer/value-messages"
import { isSafeHttpUrl } from "@/src/lib/build/urls"
import type { WidgetDefinition } from "@/src/lib/build/contracts"
import { shopifyCartCommandSchema } from "@/src/lib/build/shopify-cart"
import { ShopifyProductsView } from "./shopify-products"
import {
  shopifyOrderQuoteSchema,
  shopifyOrderSummary,
} from "@/src/lib/build/shopify-order"
import {
  shopifyReturnQuoteSchema,
  shopifyReturnSummary,
} from "@/src/lib/build/shopify-return"
import { ShopifyCartView } from "./shopify-cart"
import { CodeWidgetFrame } from "./code-widget-frame"
import { widgetText, widgetTranslationsSchema, type WidgetTranslations } from "@/src/lib/build/widget-i18n"

type ChatMessage = InspectorMessage
export type ChatInteractionHandler = (
  message: InspectorMessage,
  interaction: Record<string, unknown>,
  label: string
) => void

type WidgetComponent =
  | { type: "text"; text: string }
  | { type: "button"; label: string; actionId: string }
  | { type: "form"; fields: Array<string | FormField>; submitActionId: string }
  | { type: "list"; itemsPath: string; itemTemplate: string }
  | { type: "card"; title: string; body: string; actionId?: string | null }

type FormField = {
  name: string
  label?: string
  type?: string
  required?: boolean
  options?: string[]
}

type ChatWidget = {
  translations?: WidgetTranslations
  id?: string
  name?: string
  continuationId?: string
  submitLabel?: string
  data?: Record<string, unknown>
  code?: string
  schemaCode?: string
  functions?: WidgetDefinition["functions"]
  components: WidgetComponent[]
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function safeBrowserUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  try {
    const url = new URL(value.trim(), window.location.origin)
    return isSafeHttpUrl(url.toString()) ? url.toString() : null
  } catch {
    return null
  }
}

function widgetFromMessage(message: ChatMessage): ChatWidget | null {
  const metadata = { ...record(message.content), ...record(message.metadata) }
  const continuation = Array.isArray(metadata.continuations)
    ? metadata.continuations
        .map((item) => record(item))
        .find(
          (item) =>
            item?.type === "form" ||
            item?.type === "widget" ||
            item?.type === "client_action"
        )
    : null
  const cartCommand = shopifyCartCommandSchema.safeParse(
    record(continuation?.shopifyCart)?.command
  )
  const orderQuote = shopifyOrderQuoteSchema.safeParse(
    continuation?.shopifyOrderQuote
  )
  const returnQuote = shopifyReturnQuoteSchema.safeParse(
    continuation?.shopifyReturnQuote
  )
  const reverify = continuation?.eventName === "Continue approved change"
  let cartSummary: string | null = null
  if (cartCommand.success && cartCommand.data.operation === "add") {
    const count = cartCommand.data.items.reduce(
      (sum, item) => sum + item.quantity,
      0
    )
    cartSummary = `Add ${count} ${count === 1 ? "item" : "items"} to your cart. You can review everything before checkout.`
  } else if (cartCommand.success && cartCommand.data.operation === "set") {
    cartSummary =
      cartCommand.data.quantity === 0
        ? "Remove this item from your cart."
        : `Change this cart item's quantity to ${cartCommand.data.quantity}.`
  }
  let continuationWidget: ChatWidget | null = null
  const continuationFormActionId =
    typeof continuation?.submitActionId === "string" &&
    continuation.submitActionId.trim()
      ? continuation.submitActionId.trim()
      : typeof continuation?.actionId === "string" &&
          continuation.actionId.trim()
        ? continuation.actionId.trim()
        : null
  if (
    continuation?.type === "form" &&
    Array.isArray(continuation.fields) &&
    continuationFormActionId
  ) {
    continuationWidget = {
      id:
        typeof continuation.widgetId === "string"
          ? continuation.widgetId
          : undefined,
      name:
        typeof continuation.title === "string"
          ? continuation.title
          : typeof continuation.submitLabel === "string"
            ? continuation.submitLabel
            : "Form",
      translations: widgetTranslationsSchema.safeParse(continuation.translations).data,
      components: [
        {
          type: "form",
          fields: continuation.fields as Array<string | FormField>,
          submitActionId: continuationFormActionId,
        },
      ],
    }
  } else if (
    (continuation?.type === "widget" ||
      continuation?.type === "client_action") &&
    typeof continuation.actionId === "string"
  ) {
    continuationWidget = {
      id:
        typeof continuation.widgetId === "string"
          ? continuation.widgetId
          : undefined,
      name:
        typeof continuation.eventName === "string"
          ? continuation.eventName
          : undefined,
      components: [
        ...(continuation.eventName === "Confirm changes" ||
        reverify ||
        cartSummary
          ? [
              {
                type: "card" as const,
                title:
                  typeof continuation.title === "string"
                    ? continuation.title
                    : "Confirm change",
                body: orderQuote.success
                  ? shopifyOrderSummary(orderQuote.data)
                  : returnQuote.success
                    ? shopifyReturnSummary(returnQuote.data)
                    : (cartSummary ??
                      Object.entries(record(continuation.input) ?? {})
                        .map(
                          ([key, value]) =>
                            `${key.replace(/([a-z])([A-Z])/g, "$1 $2")}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? "Remove")}`
                        )
                        .join("\n")),
              },
            ]
          : []),
        {
          type: "button",
          label: reverify
            ? "Continue approved change"
            : orderQuote.success
              ? orderQuote.data.paymentMethod === "online"
                ? "Create checkout"
                : orderQuote.data.paymentMethod === "free"
                  ? "Place free order"
                  : "Place order"
              : returnQuote.success
                ? returnQuote.data.replacements.length
                  ? "Confirm exchange"
                  : "Confirm return"
                : typeof continuation.eventName === "string"
                  ? continuation.eventName
                  : "Continue",
          actionId: continuation.actionId,
        },
      ],
    }
  }
  const continuationDefinition = continuation
    ? record(continuation.widgetDefinition)
    : null
  // A continuation carries the definition pinned to the turn; prefer it over any current metadata copy.
  const candidates = [
    continuationDefinition,
    metadata.widget,
    metadata.widgetDefinition,
    metadata.ui,
    continuationWidget,
  ]
  for (const candidate of candidates) {
    const value = record(candidate)
    if (
      !value ||
      (!Array.isArray(value.components) && typeof value.code !== "string")
    )
      continue
    const components = (
      Array.isArray(value.components) ? value.components : []
    ).filter((component): component is WidgetComponent => {
      const item = record(component)
      if (!item || typeof item.type !== "string") return false
      if (item.type === "text") return typeof item.text === "string"
      if (item.type === "button")
        return (
          typeof item.label === "string" && typeof item.actionId === "string"
        )
      if (item.type === "form")
        return (
          Array.isArray(item.fields) &&
          item.fields.every(
            (field) =>
              typeof field === "string" ||
              (record(field)?.name && typeof record(field)?.name === "string")
          ) &&
          typeof item.submitActionId === "string"
        )
      if (item.type === "list")
        return (
          typeof item.itemsPath === "string" &&
          typeof item.itemTemplate === "string"
        )
      if (item.type === "card")
        return (
          typeof item.title === "string" &&
          typeof item.body === "string" &&
          (item.actionId == null || typeof item.actionId === "string")
        )
      return false
    })
    if (components.length || typeof value.code === "string") {
      const states = record(value.states)
      const selectedState =
        typeof metadata.widgetState === "string"
          ? record(states?.[metadata.widgetState])
          : null
      return {
        translations: widgetTranslationsSchema.safeParse(value.translations).data,
        code: typeof value.code === "string" ? value.code : undefined,
        schemaCode:
          typeof value.schemaCode === "string" ? value.schemaCode : undefined,
        functions: Array.isArray(value.functions)
          ? (value.functions.filter(
              (fn) =>
                typeof record(fn)?.name === "string" &&
                typeof record(fn)?.actionId === "string"
            ) as WidgetDefinition["functions"])
          : [],
        data: {
          ...record(states?.default),
          ...(value.code ? {} : metadata),
          ...selectedState,
          ...record(continuation?.input),
        },
        id: continuation
          ? typeof continuation.widgetId === "string"
            ? continuation.widgetId
            : undefined
          : typeof value.id === "string"
            ? value.id
            : typeof metadata.widgetId === "string"
              ? metadata.widgetId
              : undefined,
        name: typeof value.name === "string" ? value.name : undefined,
        submitLabel:
          typeof continuation?.submitLabel === "string"
            ? continuation.submitLabel
            : undefined,
        continuationId:
          typeof continuation?.continuationId === "string"
            ? continuation.continuationId
            : undefined,
        components,
      }
    }
  }
  return null
}

function resolvePath(value: Record<string, unknown>, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((current, key) => {
      const next = record(current)
      return next && Object.hasOwn(next, key) ? next[key] : undefined
    }, value)
}

function renderTemplate(template: string, value: unknown) {
  const source = record(value)
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, key: string) => {
    const result = source ? resolvePath(source, key.trim()) : undefined
    return result == null
      ? ""
      : typeof result === "string"
        ? result
        : JSON.stringify(result)
  })
}

/** Attachments and widgets use the same renderer in customer and operator chats.
 * No interaction handler means a read-only view of the customer's widget. */
export function ChatRichContent({
  message,
  onInteraction,
  completedContinuationIds,
  variant = "message",
  locale = "en",
  onCodeStatus,
}: {
  message: InspectorMessage
  locale?: string
  onInteraction?: ChatInteractionHandler
  completedContinuationIds?: ReadonlySet<string>
  variant?: "message" | "standalone" | "customer"
  onCodeStatus?: (error: string | null) => void
}) {
  const widget = widgetFromMessage(message)
  return (
    <>
      {message.attachments?.map((attachment, index) => {
        const url = safeBrowserUrl(attachment.url)
        return url ? (
          <a
            key={index}
            className="mt-2 block text-xs break-words underline underline-offset-2"
            href={url}
            target="_blank"
            rel="noreferrer"
          >
            {attachment.name ||
              attachment.caption ||
              attachment.type ||
              "Attachment"}
          </a>
        ) : null
      })}
      {message.role !== "user" ? (
        <ShopifyProductsView
          value={record(message.metadata)?.shopifyProducts}
          completedContinuationIds={completedContinuationIds}
          onSelect={
            onInteraction
              ? (interaction, label) =>
                  onInteraction(message, interaction, label)
              : undefined
          }
        />
      ) : null}
      {message.role !== "user" ? (
        <ShopifyCartView value={record(message.metadata)?.shopifyCart} />
      ) : null}
      {message.role !== "user" && widget ? (
        <ChatWidgetView
          widget={widget}
          locale={locale}
          message={message}
          completed={Boolean(
            widget.continuationId &&
            completedContinuationIds?.has(widget.continuationId)
          )}
          variant={variant}
          onCodeStatus={onCodeStatus}
          onInteraction={
            onInteraction
              ? (interaction, label) =>
                  onInteraction?.(message, interaction, label)
              : undefined
          }
        />
      ) : null}
    </>
  )
}

function ChatWidgetView({
  widget,
  locale,
  message,
  onInteraction,
  variant,
  completed = false,
  onCodeStatus,
}: {
  widget: ChatWidget
  locale: string
  message: ChatMessage
  onInteraction?: (interaction: Record<string, unknown>, label: string) => void
  variant: "message" | "standalone" | "customer"
  completed?: boolean
  onCodeStatus?: (error: string | null) => void
}) {
  const t = (text: string) => widgetText(text, locale, widget.translations)
  const metadata = widget.data ?? {
    ...record(message.content),
    ...record(message.metadata),
  }
  function interaction(actionId: string, input: Record<string, unknown>) {
    return {
      widgetId: widget.id,
      ...(widget.continuationId
        ? { continuationId: widget.continuationId }
        : {}),
      actionId,
      input,
    }
  }
  const hasForm = widget.components.some(
    (component) => component.type === "form"
  )
  if (completed && hasForm && variant === "customer") return null
  const primaryActionIndex = widget.components.findIndex(
    (component) =>
      component.type === "button" ||
      (component.type === "card" && component.actionId)
  )
  return (
    <div
      data-slot="chat-widget"
      className={cn(
        "w-full min-w-0 space-y-4 rounded-xl border border-border bg-background p-4 text-foreground",
        variant === "customer" && "mt-2 max-w-xl",
        variant === "message" && "mt-3"
      )}
    >
      {widget.name && variant !== "standalone" ? (
        <p
          className={cn(
            "font-medium",
            hasForm ? "text-base leading-6" : "text-xs text-foreground-muted"
          )}
        >
          {t(widget.name)}
        </p>
      ) : null}
      {widget.code ? (
        <CodeWidgetFrame
          locale={locale}
          translations={widget.translations}
          code={widget.code}
          schemaCode={widget.schemaCode}
          data={metadata}
          functions={widget.functions ?? []}
          onStatus={onCodeStatus}
          onAction={
            !completed && onInteraction
              ? (actionId, input, label) =>
                  onInteraction(interaction(actionId, input), label)
              : undefined
          }
        />
      ) : (
        widget.components.map((component, index) => {
          if (component.type === "text")
            return (
              <p
                key={`${message.id}-widget-${index}`}
                className="text-sm leading-5 whitespace-pre-wrap text-foreground-muted"
              >
                {renderTemplate(t(component.text), metadata)}
              </p>
            )
          if (component.type === "card")
            return (
              <div key={`${message.id}-widget-${index}`} className="space-y-2">
                <p className="text-base leading-6 font-semibold">
                  {renderTemplate(t(component.title), metadata)}
                </p>
                <p className="text-sm leading-5 whitespace-pre-wrap text-foreground-muted">
                  {renderTemplate(t(component.body), metadata)}
                </p>
                {component.actionId ? (
                  <Button
                    type="button"
                    disabled={completed || !onInteraction}
                    variant={
                      index === primaryActionIndex ? "default" : "outline"
                    }
                    className="mt-2 h-auto min-h-10 w-full rounded-lg whitespace-normal"
                    onClick={() =>
                      onInteraction?.(
                        interaction(component.actionId!, {}),
                        renderTemplate(t(component.title), metadata)
                      )
                    }
                  >
                    {t("Continue")}
                  </Button>
                ) : null}
              </div>
            )
          if (component.type === "button")
            return (
              <Button
                key={`${message.id}-widget-${index}`}
                type="button"
                disabled={completed || !onInteraction}
                variant={index === primaryActionIndex ? "default" : "outline"}
                className="h-auto min-h-10 w-full rounded-lg whitespace-normal"
                onClick={() =>
                  onInteraction?.(
                    interaction(component.actionId, {}),
                    renderTemplate(t(component.label), metadata)
                  )
                }
              >
                {renderTemplate(t(component.label), metadata)}
              </Button>
            )
          if (component.type === "list") {
            const items = resolvePath(metadata, component.itemsPath)
            return (
              <div key={`${message.id}-widget-${index}`} className="space-y-1">
                {Array.isArray(items) ? (
                  items.map((item, itemIndex) => (
                    <div
                      key={`${message.id}-widget-${index}-item-${itemIndex}`}
                      className="rounded border border-border px-2.5 py-2 text-xs"
                    >
                      {renderTemplate(t(component.itemTemplate), item)}
                    </div>
                  ))
                ) : (
                  <p className="text-xs text-foreground-muted">
                    {t("No items available.")}
                  </p>
                )}
              </div>
            )
          }
          if (completed)
            return (
              <p
                key={`${message.id}-widget-${index}`}
                role="status"
                className="flex items-center gap-2 text-sm text-foreground-muted"
              >
                <Check aria-hidden="true" className="size-4 text-success" />
                {t("Submitted")}
              </p>
            )
          return (
            <ChatWidgetForm
              key={`${message.id}-widget-${index}`}
              messageId={message.id}
              widget={widget}
              component={component}
              t={t}
              onInteraction={onInteraction}
            />
          )
        })
      )}
    </div>
  )
}

function ChatWidgetForm({
  messageId,
  widget,
  component,
  t,
  onInteraction,
}: {
  messageId?: string
  widget: ChatWidget
  t: (text: string) => string
  component: Extract<WidgetComponent, { type: "form" }>
  onInteraction?: (interaction: Record<string, unknown>, label: string) => void
}) {
  const [values, setValues] = React.useState<Record<string, string | boolean>>(
    {}
  )
  // Keep widget validation separate from a surrounding chat composer form.
  const formScope = React.useId()
  const fieldsRef = React.useRef<HTMLFieldSetElement>(null)
  function submit() {
    if (!onInteraction) return
    const fields = fieldsRef.current?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input, textarea, select")
    if (fields && Array.from(fields).some((field) => !field.reportValidity()))
      return
    onInteraction(
      {
        widgetId: widget.id,
        ...(widget.continuationId
          ? { continuationId: widget.continuationId }
          : {}),
        actionId: component.submitActionId,
        input: {
          ...Object.fromEntries(
            component.fields
              .filter(
                (field): field is FormField =>
                  typeof field !== "string" && field.type === "checkbox"
              )
              .map((field) => [field.name, false])
          ),
          ...values,
        },
      },
      t(widget.submitLabel ?? "Submit form")
    )
  }
  return (
    <fieldset
      ref={fieldsRef}
      disabled={!onInteraction}
      className="min-w-0 space-y-3"
      aria-label={t(widget.name ?? "Customer form")}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !event.shiftKey &&
          !(event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault()
          submit()
        }
      }}
    >
      {component.fields.map((field) => {
        const config =
          typeof field === "string"
            ? {
                name: field,
                label: field,
                type: "text",
                required: false,
                options: [],
              }
            : {
                name: field.name,
                label: field.label ?? field.name,
                type: field.type ?? "text",
                required: field.required ?? false,
                options: field.options ?? [],
              }
        if (config.type === "checkbox") {
          return (
            <label
              key={`${messageId}-${config.name}`}
              className="flex cursor-pointer items-start gap-2.5 text-xs leading-5"
            >
              <Checkbox
                form={formScope}
                name={config.name}
                required={config.required}
                checked={values[config.name] === true}
                className="mt-0.5"
                onChange={event => setValues(current => ({ ...current, [config.name]: event.target.checked }))}
              />
              <span>{t(config.label)}{config.required ? " *" : ""}</span>
            </label>
          )
        }
        // A single selectable value is an opt-in, not a menu of choices.
        // Keep its exact configured string as the submitted value.
        if (config.type === "select" && config.options.length === 1) {
          const option = config.options[0]
          return (
            <fieldset
              key={`${messageId}-${config.name}`}
              className="min-w-0 space-y-2"
            >
              <legend className="text-xs leading-4 font-medium">
                {t(config.label)}
                {config.required ? " *" : ""}
              </legend>
              <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-xs leading-5">
                <Checkbox
                  form={formScope}
                  name={config.name}
                  value={option}
                  required={config.required}
                  checked={values[config.name] === option}
                  className="mt-0.5"
                  onChange={(event) =>
                    setValues((current) => ({
                      ...current,
                      [config.name]: event.target.checked ? option : "",
                    }))
                  }
                />
                <span>{t(option)}</span>
              </label>
            </fieldset>
          )
        }
        return (
          <label
            key={`${messageId}-${config.name}`}
            className="block text-xs leading-4"
          >
            <span className="mb-1.5 block font-medium">
              {t(config.label)}
              {config.required ? " *" : ""}
            </span>
            {config.type === "textarea" ? (
              <Textarea
                form={formScope}
                name={config.name}
                required={config.required}
                value={String(values[config.name] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [config.name]: event.target.value,
                  }))
                }
                rows={2}
                autoSize
                className="min-h-16 rounded-lg bg-muted/40"
              />
            ) : config.type === "select" ? (
              <Select
                form={formScope}
                name={config.name}
                className="h-10 rounded-lg bg-muted/40"
                required={config.required}
                value={String(values[config.name] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [config.name]: event.target.value,
                  }))
                }
              >
                <option value="">{t("Select…")}</option>
                {config.options.map((option) => (
                  <option key={option} value={option}>
                    {t(option)}
                  </option>
                ))}
              </Select>
            ) : (
              <Input
                form={formScope}
                name={config.name}
                className="h-10 rounded-lg bg-muted/40"
                type={
                  config.type === "email" ||
                  config.type === "number" ||
                  config.type === "phone"
                    ? config.type === "phone"
                      ? "tel"
                      : config.type
                    : "text"
                }
                required={config.required}
                value={String(values[config.name] ?? "")}
                onChange={(event) =>
                  setValues((current) => ({
                    ...current,
                    [config.name]: event.target.value,
                  }))
                }
              />
            )}
          </label>
        )
      })}
      <Button
        type="button"
        className="h-auto min-h-10 w-full rounded-lg whitespace-normal"
        onClick={submit}
      >
        {t(widget.submitLabel ?? "Submit")}
      </Button>
    </fieldset>
  )
}
