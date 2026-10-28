# Localized widgets and agent skills

Prefer the user's connected Datool MCP tools. Discover the current operation schemas before reading or editing an agent, widget or skill; do not invent operation names or assume a repository feature is deployed. Read the existing definition and preserve its unrelated fields and bindings. If the deployed schema does not support `translations`, explain that limitation rather than dropping translations or putting two languages in one label.

## Authoring widgets

Start with `build_describe_operations` to verify which capabilities the connected server exposes. If available, use these read-only tools with `build:read`:

1. `build_list_widget_templates` or `build_list_skill_templates` with optional `search` and `category` filters. Lists return IDs and summaries, without full code.
2. `build_get_widget_template` or `build_get_skill_template` with a discovered `id`. The result includes a complete disabled `definition`; skill results also include suggested actions, which are descriptions rather than bindings.
3. `build_get_authoring_guide` with `topic: "widget"`, `"skill"`, `"action"` or `"agent"` for the current input JSON Schema, a valid example and save/test guidance. Some semantic constraints are enforced on save beyond the JSON Schema.
4. `build_get_widget_components` with `{}` for supported JSX imports, component props, helpers, theme tokens and translation behavior.

These tools do not create resources. Customize the returned definition, connect verified actions, then use `build_save_widget` or `build_save_procedure` according to its discovered schema. Agent examples instead belong under `configuration`. Keep new template drafts disabled until connected and verified. If the tools are absent, report the deployed capability gap; never claim the repository's local tools are already available on that server.

Use a supported template and the available component contract. Current repository templates include Portuguese (`pt-BR`) and Spanish (`es`) dictionaries with English source text. They open as disabled drafts with example data and unconnected functions. Choosing a template does not connect a service, submit a lead or book a meeting.

Export a JSX component receiving `{ data, locale, t }`. Use `t("Original text")` for headings, buttons, descriptions, empty/error text and accessible labels. Supply each translation in `definition.translations[locale][originalText]`. The Translations editor supports these dictionaries; blank or missing entries fall back to the source text. Add keys used by custom JSX explicitly. `t` is a dictionary lookup, not automatic machine translation.

```jsx
export default function Widget({ data, locale, t }) {
  return (
    <Card title={t(data.title)} body={t(data.description)}>
      <Form
        fields={[
          { name: "name", label: "Name", required: true },
          { name: "email", label: "Work email", type: "email", required: true },
          { name: "interest", label: "Interest", type: "select", options: ["Sales", "Support"] },
        ]}
        onSubmitAction="request_demo"
        submitLabel={t("Request a demo")}
      />
    </Card>
  )
}
```

Example definition fields (merge these with the code, schema and verified function binding):

```json
{
  "states": {
    "default": {
      "title": "Talk to sales",
      "description": "Tell us what you need."
    }
  },
  "translations": {
    "pt-BR": {
      "Talk to sales": "Fale com vendas",
      "Tell us what you need.": "Conte o que você precisa.",
      "Name": "Nome",
      "Work email": "E-mail profissional",
      "Interest": "Interesse",
      "Sales": "Vendas",
      "Support": "Atendimento",
      "Request a demo": "Solicitar demonstração"
    },
    "es": {
      "Talk to sales": "Habla con ventas",
      "Tell us what you need.": "Cuéntanos qué necesitas.",
      "Name": "Nombre",
      "Work email": "Correo de trabajo",
      "Interest": "Interés",
      "Sales": "Ventas",
      "Support": "Soporte",
      "Request a demo": "Solicitar una demo"
    }
  }
}
```

The built-in Form translates field labels and displayed options automatically. Keep `name`, option values, function names, IDs and input schemas canonical. Selecting “Vendas” must still submit `interest: "Sales"`. Custom submit buttons need `submitLabel={t("Request a demo")}`. Never concatenate bilingual labels such as “Name / Nome”.

Use `Intl.NumberFormat(locale, { style: "currency", currency: data.currency })` for amounts. Localization must not change the currency, amount or units. Translate complete phrases with `format(t("{{count}} items in cart"), { count })` when interpolation is needed; `t` alone does not interpolate or pluralize. Avoid ambiguous repeated keys such as single-letter weekdays. Localize display copy from action results only when a dictionary entry or localized upstream value exists; do not imply arbitrary product descriptions are automatically translated. Preserve customer-entered text and proper names.

## Conversation skills and form completion

- Follow the visitor's current conversation language and explicit preference. Country is only an initial hint, especially for multilingual countries. Use the locale provided by the chat runtime for the widget.
- Keep customer-facing questions and follow-ups in that language. Reference configured widgets with matching dictionaries; do not ask the model to translate tool input keys or enums.
- Wait for a successful submission/action result before acknowledging success. Native forms can provide an internal completion result for the agent to acknowledge naturally. Do not add a fixed “Form submitted” message, echo internal receipts or execute the lead action again. A custom JSX Form uses its bound action; translation does not change its completion behavior.
- Distinguish a received demo request from a confirmed booking. Only confirm a calendar slot after the booking action succeeds. Structured skills must continue through their configured steps.

## Verify before applying

Validate the definition, JSX and Zod schema with representative default data. Preview English, Portuguese and Spanish, plus a locale without a dictionary to check fallback. Check long labels, light/dark themes and narrow screens. Submit synthetic values through a test or preview binding and verify canonical field names and option values. For native forms, verify one submission, no duplicate lead action and an agent-written follow-up in the visitor's language. Read back the saved definition and distinguish local preview, saved draft, applied agent revision and live deployment.
