import { z } from "zod"

export const widgetTranslationsSchema = z.record(
  z
    .string()
    .regex(/^[a-z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/)
    .max(35),
  z.record(z.string().min(1).max(4_000), z.string().max(4_000))
)
export type WidgetTranslations = z.infer<typeof widgetTranslationsSchema>

const defaults: WidgetTranslations = {
  pt: {
    Submit: "Enviar",
    "Submit form": "Enviar formulário",
    Continue: "Continuar",
    Submitted: "Enviado",
    "Select…": "Selecione…",
    "No items available.": "Nenhum item disponível.",
  },
  es: {
    Submit: "Enviar",
    "Submit form": "Enviar formulario",
    Continue: "Continuar",
    Submitted: "Enviado",
    "Select…": "Selecciona…",
    "No items available.": "No hay elementos disponibles.",
  },
}

/** Text keys keep canonical field names/option values unchanged when translated. */
export function widgetText(
  text: string,
  locale = "en",
  translations?: WidgetTranslations
) {
  const language = locale.toLowerCase()
  const base = language.split("-")[0]!
  const dictionaries = Object.entries(translations ?? {})
  const exact = dictionaries.find(
    ([key]) => key.toLowerCase() === language
  )?.[1]
  const fallback =
    dictionaries.find(([key]) => key.toLowerCase() === base)?.[1] ??
    dictionaries.find(([key]) => key.toLowerCase().split("-")[0] === base)?.[1]
  return exact?.[text] || fallback?.[text] || defaults[base]?.[text] || text
}
