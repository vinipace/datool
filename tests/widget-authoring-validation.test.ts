import { expect, test } from "bun:test"
import { validateWidgetDefinition } from "../src/lib/build/widget-authoring-validation"

test("static widget validation never executes JSX or executable Zod source", () => {
  const result = validateWidgetDefinition({
    name: "Untrusted author input",
    code: 'throw new Error("JSX executed on server"); export default function Widget() { return null }',
    schemaCode:
      'throw new Error("Schema executed on server"); export default z.object({})',
    states: { default: { products: [] } },
  })
  expect(result.compiled).toBe(true)
  expect(result.rendered).toBe(false)
  expect(result.schemaValidated).toBe(false)
  expect(
    result.diagnostics.some((item) => item.code === "empty_example_data")
  ).toBe(true)
})
