import { expect, test } from "bun:test"
import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"

test("loading buttons remain labeled, announce busy state and prevent submission", () => {
  const html = renderToStaticMarkup(<Button loading type="submit">Save settings</Button>)
  expect(html).toContain('aria-busy="true"')
  expect(html).toContain('disabled=""')
  expect(html).toContain('type="submit"')
  expect(html).toContain("Save settings")
})

test("button composition retains its child link and accessible name", () => {
  const html = renderToStaticMarkup(<Button asChild variant="outline"><a href="/">Workspace</a></Button>)
  expect(html).toContain('href="/"')
  expect(html).toContain("Workspace")
  expect(html).not.toContain("<button")
})

test("shared inputs preserve native validation and description semantics", () => {
  const html = renderToStaticMarkup(<Input name="email" type="email" required invalid aria-describedby="email-error" />)
  expect(html).toContain('aria-invalid="true"')
  expect(html).toContain('aria-describedby="email-error"')
  expect(html).toContain('type="email"')
  expect(html).toContain('required=""')
})
