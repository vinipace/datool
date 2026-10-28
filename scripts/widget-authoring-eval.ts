import assert from "node:assert/strict"
import { readFile, writeFile } from "node:fs/promises"
import { createOpenAI } from "@ai-sdk/openai"
import { generateText, dynamicTool, jsonSchema, stepCountIs } from "ai"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { Page } from "playwright"
import ts from "typescript"
import type { WidgetRecord } from "../src/lib/build/contracts"
import type { WidgetPreviewReport } from "../src/lib/build/widget-validation"

/** A bounded model evaluation, not a prewritten answer replay. Only synthetic fixture data is exposed. */
export async function runWidgetAuthoringEval(options: {
  apiKey: string
  agentId: string
  catalog: Tool[]
  call<T>(name: string, input?: Record<string, unknown>): Promise<T>
  preview(
    input: Record<string, unknown>
  ): Promise<WidgetPreviewReport & { revision?: number }>
  page: Page
  output: string
}) {
  const { agentId, call, preview, page, output } = options
  const allow = new Set([
    "build_list_widget_templates",
    "build_get_widget_template",
    "build_get_widget_components",
    "build_validate_widget",
    "build_save_widget",
    "build_get_widget",
    "build_list_widgets",
  ])
  const events: Array<{
    name: string
    input: Record<string, unknown>
    result: unknown
  }> = []
  const tools = Object.fromEntries(
    options.catalog
      .filter((item) => allow.has(item.name))
      .map((item) => [
        item.name,
        dynamicTool({
          description: item.description,
          inputSchema: jsonSchema(item.inputSchema),
          execute: async (input) => {
            const args = input as Record<string, unknown>
            // Keep all model mutations inside this one disposable evaluation agent.
            if (args.agentId && args.agentId !== agentId)
              throw new Error("Use the evaluation's agentId")
            try {
              const result = await call(item.name, args)
              events.push({ name: item.name, input: args, result })
              return result
            } catch (error) {
              const result = { error: String(error) }
              events.push({ name: item.name, input: args, result })
              return result
            }
          },
        }),
      ])
  )
  const browserTool = await page.evaluate(() => {
    const tool = (
      window as unknown as {
        widgetTools: Record<
          string,
          { description: string; inputSchema: Record<string, unknown> }
        >
      }
    ).widgetTools.build_validate_widget_preview
    return { description: tool.description, inputSchema: tool.inputSchema }
  })
  tools.build_validate_widget_preview = dynamicTool({
    description: browserTool.description,
    inputSchema: jsonSchema(browserTool.inputSchema),
    execute: async (value) => {
      const input = value as Record<string, unknown>
      const result = await preview(input)
      events.push({ name: "build_validate_widget_preview", input, result })
      return result
    },
  })
  const skill = await readFile("skills/datool/SKILL.md", "utf8")
  const reference = await readFile(
    "skills/datool/references/widgets.md",
    "utf8"
  )
  const model = process.env.DATOOL_WIDGET_EVAL_MODEL ?? "gpt-4.1"
  const result = await generateText({
    model: createOpenAI({ apiKey: options.apiKey }).chat(model),
    system: `You are completing a Datool user task through the available public tools. The browser is already on the target agent's Widgets section. Use this installed skill and its widget reference:\n${skill}\n${reference}`,
    prompt: `Create a product recommendations widget for a Shopify store on agent ${agentId}. It should show product images, names, prices and View product links. Leave it disabled for review; no cart actions. Use clearly synthetic preview products and links on https://shop.example.test/products/. I want to open the saved editor and see a useful preview. No live Shopify connection is available in this evaluation.`,
    tools,
    stopWhen: stepCountIs(24),
    maxOutputTokens: 8000,
    temperature: 0,
    maxRetries: 1,
    abortSignal: AbortSignal.timeout(240000),
  })
  await writeFile(
    `${output}/model-events.json`,
    JSON.stringify(
      { model, events, text: result.text, usage: result.totalUsage },
      null,
      2
    )
  )
  const firstSave = events.findIndex(
    (item) => item.name === "build_save_widget"
  )
  assert(firstSave >= 0, "Authoring model did not save a widget")
  for (const name of [
    "build_list_widget_templates",
    "build_get_widget_template",
    "build_get_widget_components",
  ])
    assert(
      events.slice(0, firstSave).some((item) => item.name === name),
      `Model skipped discovery: ${name}`
    )
  const writes = events.filter(
    (item) =>
      item.name === "build_save_widget" && (item.result as WidgetRecord)?.id
  )
  assert(writes.length > 0)
  const saved = writes.at(-1)!.result as WidgetRecord
  const read = await call<WidgetRecord>("build_get_widget", {
    agentId,
    widgetId: saved.id,
  })
  assert.equal(read.definition.enabled, false)
  assert.equal(
    read.definition.functions.length,
    0,
    "Recommendation-only widget must not add cart actions"
  )
  assert(
    events.some((item) => {
      const report = item.result as WidgetPreviewReport & { revision?: number }
      return (
        item.name === "build_validate_widget_preview" &&
        item.input.widgetId === saved.id &&
        (item.input.state ?? "default") === "default" &&
        !item.input.allowEmpty &&
        report.revision === read.revision &&
        report.valid &&
        report.rendered &&
        report.schemaValidated
      )
    }),
    "Model did not validate the final saved revision's default preview"
  )
  const source = ts.createSourceFile(
    "widget.tsx",
    read.definition.code!,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  )
  const componentNames = new Set<string>()
  // Grade public component use, preserving valid import aliases and namespaces.
  const imports = new Map<string, string>()
  const namespaces = new Set<string>()
  for (const statement of source.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      statement.moduleSpecifier.text !== "@datool/widgets"
    )
      continue
    const bindings = statement.importClause?.namedBindings
    if (bindings && ts.isNamespaceImport(bindings))
      namespaces.add(bindings.name.text)
    if (bindings && ts.isNamedImports(bindings))
      for (const specifier of bindings.elements)
        imports.set(
          specifier.name.text,
          (specifier.propertyName ?? specifier.name).text
        )
  }
  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName
      const name =
        ts.isPropertyAccessExpression(tag) &&
        namespaces.has(tag.expression.getText(source))
          ? tag.name.text
          : (imports.get(tag.getText(source)) ?? tag.getText(source))
      componentNames.add(name)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  assert(componentNames.has("Image"), "Use the supported Image component")
  assert(
    ["Box", "Row", "Col", "Card"].some((name) => componentNames.has(name)),
    "Use supported layout components"
  )
  for (const width of [360, 768]) {
    const report = await preview({ widgetId: saved.id, width })
    assert(
      report.valid && report.rendered && report.schemaValidated,
      JSON.stringify(report)
    )
    assert(
      (report.imageCount ?? 0) >= 2,
      "Default preview must show representative products"
    )
  }
  await page.reload()
  await page
    .getByRole("button", { name: read.definition.name, exact: true })
    .click()
  const frame = page.frameLocator('iframe[title="Widget content"]')
  const links = frame.getByRole("link", { name: /view product/i })
  await links.first().waitFor()
  assert((await links.count()) >= 2)
  const href = await links.first().getAttribute("href")
  assert(href?.startsWith("https://shop.example.test/products/"))
  // Stub only the destination store: the widget/runtime/navigation remain real.
  await page.context().route("https://shop.example.test/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<h1>Synthetic product page</h1>",
    })
  )
  const popupPromise = page.waitForEvent("popup")
  await links.first().click()
  const popup = await popupPromise
  await popup.getByRole("heading", { name: "Synthetic product page" }).waitFor()
  await popup.close()
  await page.screenshot({ path: `${output}/model-saved-widget.png` })
  return {
    ran: true,
    model,
    widgetId: saved.id,
    revision: read.revision,
    usage: result.totalUsage,
    checks: [
      "discovery before save",
      "shared components",
      "representative defaults",
      "saved preview",
      "mobile/desktop",
      "product link",
    ],
  }
}
