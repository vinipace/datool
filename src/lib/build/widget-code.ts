import type { WidgetComponent, WidgetDefinition } from "./contracts"

type WidgetFunction = WidgetDefinition["functions"][number]

export const widgetCodeDeclarations = `
declare const React: any;
declare const Box: (props: any) => any;
declare const Col: (props: any) => any;
declare const Row: (props: any) => any;
declare const Text: (props: any) => any;
declare const Card: (props: any) => any;
declare const Button: (props: any) => any;
declare const Form: (props: any) => any;
declare const List: (props: any) => any;
declare const Image: (props: any) => any;
declare function get(value: unknown, path: string): any;
declare function format(template: string, data: unknown): string;
`

/** Converts legacy components at the authoring boundary; persisted history is unchanged. */
export function widgetComponentCode(
  component: WidgetComponent,
  functions: WidgetFunction[],
  translate = false
) {
  function actionName(actionId: string) {
    let fn = functions.find((item) => item.actionId === actionId)
    if (!fn) {
      let index = functions.length + 1
      while (functions.some((item) => item.name === `action${index}`)) index++
      fn = {
        name: `action${index}`,
        actionId,
        inputSchema: {},
        outputSchema: {},
      }
      functions.push(fn)
    }
    return JSON.stringify(fn.name)
  }
  const template = (text: string, scope = "data") => {
    const value = translate
      ? `t(${JSON.stringify(text)})`
      : JSON.stringify(text)
    return text.includes("{{") ? `format(${value}, ${scope})` : value
  }
  switch (component.type) {
    case "text":
      return `<Text>{${template(component.text)}}</Text>`
    case "card":
      return `<Card title={${template(component.title)}} body={${template(component.body)}}${component.actionId ? ` onClickAction={${actionName(component.actionId)}}` : ""} />`
    case "button":
      return `<Button onClickAction={${actionName(component.actionId)}}>{${template(component.label)}}</Button>`
    case "form":
      return `<Form fields={${JSON.stringify(component.fields)}} onSubmitAction={${actionName(component.submitActionId)}} />`
    case "list":
      return `<List items={get(data, ${JSON.stringify(component.itemsPath)}) ?? []} renderItem={(item) => ${template(component.itemTemplate, "item")}} />`
  }
}

export function widgetAsCode(definition: WidgetDefinition): WidgetDefinition {
  const schemaCode =
    definition.schemaCode ??
    widgetSchemaFromData(definition.states.default ?? {})
  if (definition.code) return { ...definition, schemaCode }
  const functions = definition.functions.map((fn) => ({ ...fn }))
  const children = definition.components
    .map(
      (component) => `      ${widgetComponentCode(component, functions, true)}`
    )
    .join("\n")
  return {
    ...definition,
    schemaCode,
    functions,
    components: [],
    code: `export default function Widget({ data, t }) {\n  return (\n    <Col gap={16}>\n${children}\n    </Col>\n  )\n}\n`,
  }
}

/** A starting schema inferred from saved default data; authors can refine it in Schema. */
export function widgetSchemaFromData(data: unknown): string {
  function type(value: unknown, depth = 0): string {
    if (depth > 12) return "z.unknown()"
    if (value === null) return "z.unknown().nullable()"
    if (typeof value === "string") return "z.string()"
    if (typeof value === "number") return "z.number()"
    if (typeof value === "boolean") return "z.boolean()"
    if (Array.isArray(value)) {
      const items = [...new Set(value.map((item) => type(item, depth + 1)))]
      return `z.array(${items.length > 1 ? `z.union([${items.join(", ")}])` : (items[0] ?? "z.unknown()")})`
    }
    if (value && typeof value === "object") {
      const fields = Object.entries(value).map(
        ([key, child]) => `${JSON.stringify(key)}: ${type(child, depth + 1)}`
      )
      return `z.object({${fields.length ? `\n  ${fields.join(",\n  ")}\n` : ""}})`
    }
    return "z.unknown()"
  }
  return `import { z } from "zod"\n\nexport default ${type(data)}\n`
}
