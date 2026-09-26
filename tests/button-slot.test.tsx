import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "../components/ui/button"

test("button links render with and without a loading indicator", () => {
  for (const loading of [false, true]) {
    const html = renderToStaticMarkup(<Button asChild loading={loading}><a href="/">Organizations</a></Button>)
    expect(html).toContain('href="/"')
    expect(html).toContain("Organizations")
    expect(html.includes("<svg")).toBe(loading)
  }
})

test("ordinary buttons preserve multiple children", () => {
  expect(renderToStaticMarkup(<Button><span>+</span>Create</Button>)).toContain("<span>+</span>Create")
})
