import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { SyntaxCode } from "@/components/ui/syntax-code"

test("missing code renders empty instead of crashing the surrounding inspector", () => {
  for (const language of ["json", "yaml", "filter", "javascript"] as const) {
    for (const text of [undefined, null, ""]) {
      const html = renderToStaticMarkup(
        <SyntaxCode text={text} language={language} />
      )
      expect(/<code\b[^>]*><\/code>/.test(html)).toBe(true)
    }
  }
})
