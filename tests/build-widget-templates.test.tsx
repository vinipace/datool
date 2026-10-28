import { describe, expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { z } from "zod"
import { widgetDefinitionSchema } from "@/src/lib/build/contracts"
import {
  compileWidgetCode,
  compileWidgetSchema,
} from "@/src/lib/build/widget-compiler"
import { widgetText } from "@/src/lib/build/widget-i18n"
import { widgetTemplates } from "@/src/lib/build/widget-templates"

// Exercise the template's compiled JSX and public component props. Runtime Form
// label translation and submission are owned by the localized-widget browser tests.
function renderTemplate(id: string, locale: string) {
  const definition = widgetDefinitionSchema.parse(
    widgetTemplates.find((template) => template.id === id)!.definition
  )
  const schema: { default?: z.ZodType } = {}
  new Function(
    "exports",
    "require",
    compileWidgetSchema(definition.schemaCode!)
  )(schema, () => ({ z }))
  const data = schema.default!.parse(definition.states.default)
  const actions: unknown[] = []
  const forms: Array<{
    fields: Array<{ name: string; label: string; options?: string[] }>
  }> = []
  const components = {
    Box: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Col: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Row: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Text: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
    Card: ({
      title,
      body,
      children,
    }: {
      title: string
      body: string
      children: React.ReactNode
    }) => (
      <section>
        <h3>{title}</h3>
        <p>{body}</p>
        {children}
      </section>
    ),
    Button: ({
      children,
      onClickAction,
    }: {
      children: React.ReactNode
      onClickAction: unknown
    }) => {
      actions.push(onClickAction)
      return <button>{children}</button>
    },
    Form: (
      props: (typeof forms)[number] & {
        submitLabel: string
        onSubmitAction: unknown
      }
    ) => {
      forms.push(props)
      actions.push(props.onSubmitAction)
      return <button>{props.submitLabel}</button>
    },
    List: ({
      items,
      renderItem,
    }: {
      items: unknown[]
      renderItem: (item: unknown) => React.ReactNode
    }) => (
      <div>
        {items.map((item, i) => (
          <div key={i}>{renderItem(item)}</div>
        ))}
      </div>
    ),
    Image: ({ alt }: { alt: string }) => <span>{alt}</span>,
    format: (text: string, values: Record<string, unknown>) =>
      text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(values[key])),
  }
  const exports: {
    default?: React.ComponentType<{
      data: unknown
      locale: string
      t: (text: string) => string
    }>
  } = {}
  new Function(
    "React",
    "exports",
    ...Object.keys(components),
    compileWidgetCode(definition.code!)
  )(React, exports, ...Object.values(components))
  return {
    html: renderToStaticMarkup(
      React.createElement(exports.default!, {
        data,
        locale,
        t: (text) => widgetText(text, locale, definition.translations),
      })
    ),
    actions,
    forms,
  }
}

describe("localized widget starters", () => {
  for (const [id, en, pt, es] of [
    ["contact-form", "Send message", "Enviar mensagem", "Enviar mensaje"],
    [
      "demo-request",
      "Request a demo",
      "Solicitar demonstração",
      "Solicitar una demo",
    ],
    [
      "support-request",
      "Send request",
      "Enviar solicitação",
      "Enviar solicitud",
    ],
    ["quick-choices", "Get support", "Obter ajuda", "Obtener ayuda"],
    ["order-lookup", "Find order", "Buscar pedido", "Buscar pedido"],
    ["order-summary", "Processing", "Em processamento", "En proceso"],
    [
      "buy-products",
      "Add to cart",
      "Adicionar ao carrinho",
      "Añadir al carrito",
    ],
    [
      "get-cart",
      "Continue to checkout",
      "Continuar para o pagamento",
      "Continuar al pago",
    ],
    [
      "usage-chart",
      "Total credits used",
      "Total de créditos usados",
      "Total de créditos usados",
    ],
    ["gym-class-booking", "Book class", "Reservar aula", "Reservar clase"],
    [
      "hotel-booking",
      "Check availability",
      "Verificar disponibilidade",
      "Consultar disponibilidad",
    ],
    [
      "fetch-weather",
      "Refresh weather",
      "Atualizar previsão",
      "Actualizar el tiempo",
    ],
  ]) {
    test(`${id} produces localized JSX with schema-valid defaults`, () => {
      expect(renderTemplate(id, "en").html).toContain(en)
      expect(renderTemplate(id, "pt-BR").html).toContain(pt)
      expect(renderTemplate(id, "es").html).toContain(es)
    })
  }

  test("localized copy keeps action bindings and form field values canonical", () => {
    const choices = renderTemplate("quick-choices", "pt-BR")
    expect(choices.html).toContain("Fale com vendas")
    expect(choices.actions).toEqual([
      { functionName: "choose_topic", additionalInputs: { topic: "sales" } },
      { functionName: "choose_topic", additionalInputs: { topic: "support" } },
      { functionName: "choose_topic", additionalInputs: { topic: "order" } },
    ])
    const demo = renderTemplate("demo-request", "es")
    expect(demo.actions).toEqual(["submit"])
    expect(
      demo.forms[0].fields.find((field) => field.name === "companySize")
    ).toMatchObject({
      label: "Company size",
      options: ["1–10", "11–50", "51–200", "201–500", "500+"],
    })
    expect(demo.forms[0].fields.map((field) => field.name)).toEqual([
      "name",
      "email",
      "phone",
      "companySize",
      "message",
    ])
  })

  test("currency formatting follows locale without changing prices, IDs or currency", () => {
    const products = renderTemplate("buy-products", "pt-BR")
    expect(products.html).toContain("US$ 64,00")
    expect(products.actions[0]).toEqual({
      functionName: "add_to_cart",
      additionalInputs: { productId: "example-trainer" },
    })
    const cart = renderTemplate("get-cart", "es")
    expect(cart.html).toContain("2 artículos en el carrito")
    expect(cart.html).toContain("143,00")
    expect(cart.actions).toEqual([
      {
        functionName: "checkout",
        additionalInputs: { cartId: "example-cart" },
      },
    ])
  })

  test("missing dictionaries retain readable source copy", () => {
    expect(renderTemplate("demo-request", "fr-FR").html).toContain(
      "Request a demo"
    )
    expect(renderTemplate("quick-choices", "fr-FR").html).toContain(
      "Choose a topic to continue."
    )
  })
})
