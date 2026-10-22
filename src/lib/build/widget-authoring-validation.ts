import { widgetDefinitionSchema } from "./contracts"
import { widgetAsCode } from "./widget-code"
import { compileWidgetCode, compileWidgetSchema } from "./widget-compiler"
import type { WidgetDiagnostic } from "./widget-validation"

/** Static checks only: never evaluate customer JSX or Zod source in the server. */
export function validateWidgetDefinition(
  input: unknown,
  state = "default",
  allowEmpty = false
) {
  const diagnostics: WidgetDiagnostic[] = []
  let compiled = false
  try {
    const definition = widgetAsCode(widgetDefinitionSchema.parse(input))
    compileWidgetCode(definition.code!)
    if (definition.schemaCode) compileWidgetSchema(definition.schemaCode)
    compiled = true
    if (!Object.hasOwn(definition.states, state)) {
      diagnostics.push({
        code: "missing_state",
        severity: "error",
        message: `Provide representative data for the ${state} state.`,
      })
    } else if (!allowEmpty) {
      const data = definition.states[state]
      const arrays = Object.values(data).filter(Array.isArray)
      if (
        !Object.keys(data).length ||
        (arrays.length > 0 && arrays.every((items) => items.length === 0))
      )
        diagnostics.push({
          code: "empty_example_data",
          severity: "warning",
          message:
            "Preview data is empty. Add representative examples, or use allowEmpty for an intentional empty-state check.",
        })
    }
    for (const fn of definition.functions) {
      if (!fn.actionId)
        diagnostics.push({
          code: "unbound_function",
          severity: "warning",
          message: `Function ${fn.name} has no action binding. Keep the widget disabled until it is connected.`,
        })
    }
  } catch (error) {
    diagnostics.push({
      code: "invalid_definition",
      severity: "error",
      message: String(error).slice(0, 2000),
    })
  }
  return {
    compiled,
    rendered: false as const,
    schemaValidated: false as const,
    valid: !diagnostics.some((item) => item.severity === "error"),
    diagnostics,
    nextStep:
      "Open the agent's Widgets section and call the browser tool build_validate_widget_preview with this definition, state and allowEmpty. It renders in the isolated iframe. Static validation does not prove data matches the executable Zod schema, images load, or the preview has visible content. Reopen the saved widget and inspect desktop/mobile and light/dark appearances before delivery.",
  }
}
