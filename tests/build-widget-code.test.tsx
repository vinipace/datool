import { describe, expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { z } from "zod"
import {
  compileWidgetCode,
  compileWidgetSchema,
} from "@/src/lib/build/widget-compiler"
import { widgetAsCode } from "@/src/lib/build/widget-code"
import { widgetDefinitionSchema } from "@/src/lib/build/contracts"

describe("widget code authoring", () => {
  test("compiles JSX modules with hooks, conditional content, and mapped state data", () => {
    const source = `import { useState } from "react"
      export default function Widget({ data }) {
        const [visible] = useState(true)
        return <section>{visible && data.products.map(product => <p key={product.id}>{product.name}</p>)}</section>
      }`
    const exports: { default?: React.ComponentType<{ data: unknown }> } = {}
    new Function("React", "exports", "require", compileWidgetCode(source))(
      React,
      exports,
      () => React
    )
    expect(
      renderToStaticMarkup(
        React.createElement(exports.default!, {
          data: { products: [{ id: "one", name: "Report" }] },
        })
      )
    ).toBe("<section><p>Report</p></section>")
  })

  test("Zod schema code validates nested data and applies defaults before rendering", () => {
    const exports: { default?: z.ZodType } = {}
    new Function(
      "exports",
      "require",
      compileWidgetSchema(`import { z } from "zod"
      const Product = z.object({ name: z.string(), price: z.number().positive() })
      export default z.object({ products: z.array(Product), visible: z.boolean().default(true) })`)
    )(exports, () => ({ z }))
    expect(
      exports.default!.parse({ products: [{ name: "Report", price: 12 }] })
    ).toEqual({ products: [{ name: "Report", price: 12 }], visible: true })
    expect(
      exports.default!.safeParse({ products: [{ name: "Report", price: -1 }] })
        .success
    ).toBe(false)
  })

  test("rejects malformed code and missing default exports", () => {
    expect(() =>
      compileWidgetCode("export default function Widget() { return <Col> }")
    ).toThrow()
    expect(() =>
      compileWidgetSchema('import { z } from "zod"; export default z.object({')
    ).toThrow()
    expect(() => compileWidgetSchema("const schema = z.object({})")).toThrow(
      "Export a default Zod schema"
    )
  })

  test("opens legacy widgets as JSX with their named action bindings and inferred Zod data shape", () => {
    const legacy = widgetDefinitionSchema.parse({
      name: "Order",
      states: {
        default: { title: "Ready", items: [{ name: "Report", count: 1 }] },
      },
      components: [
        { type: "button", label: "{{title}}", actionId: "confirm-order" },
      ],
      functions: [{ name: "confirm", actionId: "confirm-order" }],
    })
    const migrated = widgetAsCode(legacy)
    const calls: Array<Record<string, unknown>> = []
    const exports: { default?: React.ComponentType<{ data: unknown }> } = {}
    new Function(
      "React",
      "exports",
      "Col",
      "Button",
      "format",
      compileWidgetCode(migrated.code!)
    )(
      React,
      exports,
      "div",
      (props: { children: React.ReactNode; onClickAction: string }) => {
        calls.push({ action: props.onClickAction })
        return <button>{props.children}</button>
      },
      (_: string, data: { title: string }) => data.title
    )
    expect(
      renderToStaticMarkup(
        React.createElement(exports.default!, { data: { title: "Ready" } })
      )
    ).toContain("<button>Ready</button>")
    expect(calls).toEqual([{ action: "confirm" }])
    expect(
      migrated.functions.find((fn) => fn.name === "confirm")?.actionId
    ).toBe("confirm-order")
    const schema: { default?: z.ZodType } = {}
    new Function(
      "exports",
      "require",
      compileWidgetSchema(migrated.schemaCode!)
    )(schema, () => ({ z }))
    expect(schema.default!.safeParse(legacy.states.default).success).toBe(true)
    expect(schema.default!.safeParse({ title: 42, items: [] }).success).toBe(
      false
    )
  })
})
