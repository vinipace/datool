import { describe, expect, test } from "bun:test"
import { isAllowedEditor, safeHref } from "../cms/access"
import { assertLocalCMSDatabase } from "../scripts/cms-local-database"

describe("CMS trust boundaries", () => {
  test("editor allowlist is explicit and fails closed", () => {
    expect(isAllowedEditor("user-a", " user-a, user-b ")).toBe(true)
    expect(isAllowedEditor("user-c", "user-a,user-b")).toBe(false)
    expect(isAllowedEditor("user-a", "")).toBe(false)
    expect(isAllowedEditor(undefined, "user-a")).toBe(false)
  })
  test("links reject script and protocol-relative URLs", () => {
    for (const href of [
      "/faq",
      "#details",
      "https://example.com/path",
      "mailto:hello@example.com",
    ])
      expect(safeHref(href)).toBe(true)
    for (const href of [
      "javascript:alert(1)",
      "//evil.example",
      "/\\evil.example",
      "data:text/html,test",
      "https://user:pass@example.com",
    ])
      expect(safeHref(href)).toBe(false)
  })
  test("seeding cannot target remote or ordinary application databases", () => {
    expect(() =>
      assertLocalCMSDatabase("postgresql://localhost/datool_cms_test")
    ).not.toThrow()
    for (const url of [
      undefined,
      "postgresql://remote.example/datool_cms",
      "postgresql://localhost/datool",
      "postgresql://localhost/blog_template",
    ])
      expect(() => assertLocalCMSDatabase(url)).toThrow()
  })
})
