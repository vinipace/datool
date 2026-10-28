/* eslint-disable react-refresh/only-export-components -- Standalone sandbox bundle, not a Fast Refresh module. */
import * as React from "react"
import { createRoot } from "react-dom/client"
import { z } from "zod"
import { widgetText } from "../lib/build/widget-i18n"
import {
  compileWidgetCode,
  compileWidgetSchema,
} from "../lib/build/widget-compiler"
import "./widget-runtime.css"

type Action =
  string | { functionName: string; additionalInputs?: Record<string, unknown> }
const Context = React.createContext<{
  enabled: boolean
  t: (key: string) => string
  dispatch: (
    action: Action,
    input?: Record<string, unknown>,
    label?: string
  ) => void
}>({ enabled: false, dispatch: () => {}, t: (key) => key })
type LayoutProps = React.HTMLAttributes<HTMLDivElement> & {
  gap?: number
  padding?: number
  width?: number | string
}
function Box({ gap = 0, padding = 0, width, style, ...props }: LayoutProps) {
  return <div {...props} style={{ gap, padding, width, ...style }} />
}
function Col(props: LayoutProps) {
  return (
    <Box
      {...props}
      style={{ display: "flex", flexDirection: "column", ...props.style }}
    />
  )
}
function Row(props: LayoutProps) {
  return (
    <Box
      {...props}
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        ...props.style,
      }}
    />
  )
}
function Text({
  children,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p {...props}>{children}</p>
}
function Button({
  onClickAction,
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  onClickAction?: Action
  variant?: "primary" | "secondary"
}) {
  const context = React.useContext(Context)
  return (
    <button
      {...props}
      type="button"
      data-variant={variant}
      disabled={props.disabled || !context.enabled}
      onClick={(event) => {
        props.onClick?.(event)
        if (onClickAction)
          context.dispatch(
            onClickAction,
            {},
            event.currentTarget.textContent ?? undefined
          )
      }}
    >
      {children}
    </button>
  )
}
function Card({
  title,
  body,
  children,
  onClickAction,
}: {
  title?: React.ReactNode
  body?: React.ReactNode
  children?: React.ReactNode
  onClickAction?: Action
}) {
  return (
    <section className="widget-card">
      {title && <h3>{title}</h3>}
      {body && <p className="widget-muted">{body}</p>}
      {children}
      {onClickAction && <Button onClickAction={onClickAction}>Continue</Button>}
    </section>
  )
}
function List({
  items = [],
  renderItem,
}: {
  items?: unknown[]
  renderItem: (item: unknown, index: number) => React.ReactNode
}) {
  return (
    <div className="widget-list">
      {items.map((item, index) => (
        <div key={index}>{renderItem(item, index)}</div>
      ))}
    </div>
  )
}
function Image({
  src,
  alt = "",
  fit = "cover",
  ...props
}: React.ImgHTMLAttributes<HTMLImageElement> & { fit?: "contain" | "cover" }) {
  if (
    typeof src !== "string" ||
    (!/^https:\/\//.test(src) &&
      !/^\/widget-template-assets\/[a-z0-9-]+\.webp$/.test(src))
  )
    return null
  // Images remain in the opaque iframe and cannot access parent credentials.
  return (
    <img
      {...props}
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      style={{ maxWidth: "100%", objectFit: fit, ...props.style }}
    />
  )
}
type Field = {
  name: string
  label?: string
  type?: string
  required?: boolean
  options?: string[]
}
function Form({
  fields,
  onSubmitAction,
  submitLabel = "Submit",
}: {
  fields: Array<string | Field>
  onSubmitAction: Action
  submitLabel?: string
}) {
  const context = React.useContext(Context)
  const ref = React.useRef<HTMLFieldSetElement>(null)
  const scope = React.useId()
  const [values, setValues] = React.useState<Record<string, string>>({})
  function submit() {
    const controls = ref.current?.querySelectorAll<
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
    >("input,textarea,select")
    if (
      controls &&
      Array.from(controls).some((field) => !field.reportValidity())
    )
      return
    context.dispatch(onSubmitAction, values, submitLabel)
  }
  return (
    <fieldset
      ref={ref}
      className="widget-form"
      disabled={!context.enabled}
      onKeyDown={(event) => {
        if (
          event.key === "Enter" &&
          !(event.target instanceof HTMLTextAreaElement)
        ) {
          event.preventDefault()
          submit()
        }
      }}
    >
      {fields.map((field) => {
        const config = typeof field === "string" ? { name: field } : field
        const update = (value: string) =>
          setValues((previous) => ({ ...previous, [config.name]: value }))
        const common = {
          form: scope,
          name: config.name,
          required: config.required,
          value: values[config.name] ?? "",
          onChange: (
            event: React.ChangeEvent<
              HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
            >
          ) => update(event.target.value),
        }
        return (
          <label key={config.name}>
            <span>
              {context.t(config.label ?? config.name)}
              {config.required ? " *" : ""}
            </span>
            {config.type === "textarea" ? (
              <textarea {...common} rows={2} />
            ) : config.type === "select" ? (
              <select {...common}>
                <option value="">{context.t("Select…")}</option>
                {config.options?.map((option) => (
                  <option key={option} value={option}>{context.t(option)}</option>
                ))}
              </select>
            ) : (
              <input
                {...common}
                type={
                  config.type === "phone"
                    ? "tel"
                    : ["email", "number"].includes(config.type ?? "")
                      ? config.type
                      : "text"
                }
              />
            )}
          </label>
        )
      })}
      <Button onClick={submit}>{submitLabel}</Button>
    </fieldset>
  )
}
function get(value: unknown, path: string): unknown {
  return path
    .split(".")
    .filter(Boolean)
    .reduce<unknown>(
      (current, key) =>
        current && typeof current === "object" && Object.hasOwn(current, key)
          ? (current as Record<string, unknown>)[key]
          : undefined,
      value
    )
}
function format(template: string, data: unknown) {
  return template.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, path: string) => {
    const value = get(data, path.trim())
    return value == null
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value)
  })
}
const components = {
  Box,
  Col,
  Row,
  Text,
  Card,
  Button,
  Form,
  List,
  Image,
  get,
  format,
}
const root = createRoot(document.getElementById("root")!)
let requestId = 0
function report(error: string | null) {
  parent.postMessage({ type: "widget-status", requestId, error }, "*")
}
class Boundary extends React.Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null }
  static getDerivedStateFromError(error: unknown) {
    return { error: String(error) }
  }
  componentDidCatch(error: unknown) {
    report(String(error))
  }
  render() {
    return this.state.error ? (
      <pre role="alert">{this.state.error}</pre>
    ) : (
      this.props.children
    )
  }
}
type WidgetProps = { data: unknown; locale: string; t: (key: string) => string }
let cached:
  | { code: string; Component: React.ComponentType<WidgetProps> }
  | undefined
let cachedSchema: { code: string; schema: z.ZodType } | undefined
window.addEventListener("message", (event) => {
  if (event.source !== parent || event.data?.type !== "render-widget") return
  const value = event.data
  requestId = value.requestId
  for (const [name, setting] of Object.entries(value.theme ?? {})) {
    if (typeof setting !== "string") continue
    if (name.startsWith("--color-"))
      document.documentElement.style.setProperty(name, setting)
    else if (name === "colorScheme")
      document.documentElement.style.colorScheme = setting
  }
  try {
    let data = value.data
    if (value.schemaCode) {
      if (!cachedSchema || cachedSchema.code !== value.schemaCode) {
        const exports: { default?: z.ZodType } = {}
        new Function(
          "exports",
          "require",
          "z",
          compileWidgetSchema(value.schemaCode)
        )(
          exports,
          (name: string) => {
            if (name === "zod") return { z, ...z }
            throw new Error('Schema imports must come from "zod".')
          },
          z
        )
        if (
          !exports.default ||
          typeof exports.default.safeParse !== "function"
        ) {
          throw new Error("Schema: export a default Zod schema.")
        }
        cachedSchema = { code: value.schemaCode, schema: exports.default }
      }
      const parsed = cachedSchema.schema.safeParse(data)
      if (!parsed.success)
        throw new Error(
          `Data does not match Schema: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "data"}: ${issue.message}`).join("; ")}`
        )
      data = parsed.data
    }
    if (!cached || cached.code !== value.code) {
      const compiled = compileWidgetCode(value.code)
      const exports: { default?: React.ComponentType<WidgetProps> } = {}
      new Function(
        "React",
        "exports",
        "require",
        ...Object.keys(components),
        compiled
      )(
        React,
        exports,
        (name: string) => {
          if (name === "react") return React
          if (name === "@datool/widgets") return components
          throw new Error('Import from "react" or "@datool/widgets" only.')
        },
        ...Object.values(components)
      )
      if (typeof exports.default !== "function")
        throw new Error("Export a default React component.")
      cached = { code: value.code, Component: exports.default }
    }
    const Component = cached.Component
    const renderRequestId = requestId
    const dispatch = (
      action: Action,
      input: Record<string, unknown> = {},
      label?: string
    ) => {
      const functionName =
        typeof action === "string" ? action : action.functionName
      if (!value.enabled || !value.functions.includes(functionName)) return
      parent.postMessage(
        {
          type: "widget-action",
          requestId: renderRequestId,
          functionName,
          input: {
            ...(typeof action === "object" ? action.additionalInputs : {}),
            ...input,
          },
          label,
        },
        "*"
      )
    }
    report(null)
    root.render(
      <Boundary
        key={`${value.code}:${value.schemaCode ?? ""}:${JSON.stringify(data)}`}
      >
        <Context.Provider
          value={{
            enabled: value.enabled,
            dispatch,
            t: (key) => widgetText(key, value.locale, value.translations),
          }}
        >
          <Component
            data={data}
            locale={value.locale ?? "en"}
            t={(key) => widgetText(key, value.locale, value.translations)}
          />
        </Context.Provider>
      </Boundary>
    )
  } catch (error) {
    report(String(error))
    root.render(<pre role="alert">{String(error)}</pre>)
  }
})
new ResizeObserver(() =>
  parent.postMessage(
    {
      type: "widget-height",
      requestId,
      height: document.getElementById("root")!.getBoundingClientRect().height,
    },
    "*"
  )
).observe(document.getElementById("root")!)
window.addEventListener("error", (event) => report(event.message))
parent.postMessage({ type: "widget-ready" }, "*")
