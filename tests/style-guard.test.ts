import { describe, expect, test } from "bun:test"
import { inspectStyles, checkSources } from "../scripts/check-styles.mjs"

describe("semantic style guard", () => {
  test("rejects named arbitrary colors and CSS literals alongside variables", () => {
    expect(
      inspectStyles(
        "app/example.tsx",
        '<div className="bg-[white] text-[color:red] [background:#123456]" />'
      ).length
    ).toBeGreaterThan(2)
    expect(
      inspectStyles(
        "components/example.module.css",
        ".x { color: var(--foreground); background: #fff; }"
      ).map((item) => item.signature)
    ).toContain("#fff")
    expect(
      inspectStyles("app/example.tsx", '<svg fill={"red"} />').map(
        (item) => item.signature
      )
    ).toContain("fill:red")
  })
  test("rejects palette variants, arbitrary color and literal inline colors", () => {
    const source = `<div className="bg-black hover:text-zinc-400 border-[#123456] dark:ring-red-500/20" style={{ color: "#ffffff", backgroundColor: "rgb(0, 0, 0)" }} />`
    const signatures = inspectStyles("app/example/page.tsx", source).map(
      (item) => item.signature
    )
    for (const signature of [
      "bg-black",
      "text-zinc-400",
      "border-[#123456]",
      "ring-red-500/20",
      "#ffffff",
      "rgb(0, 0, 0)",
    ])
      expect(signatures).toContain(signature)
  })
  test("allows semantic tokens, CSS variable styles and arbitrary dimensions", () => {
    const source = `<div className="bg-background text-foreground-muted border-border text-[10px] w-[calc(100%-2rem)]" style={{color: "var(--info)"}} />`
    expect(inspectStyles("app/example/page.tsx", source)).toEqual([])
  })
  test("ignores comments but catches template and named inline colors", () => {
    const source =
      '// bg-black\nconst x = `bg-white ${active ? "text-zinc-400" : "text-foreground"}`; const y = <div style={{ color: "red" }} />'
    expect(
      inspectStyles("app/example/page.tsx", source).map(
        (item) => item.signature
      )
    ).toEqual(["bg-white", "text-zinc-400", "color:red"])
  })
  test("allows only exact existing violation counts and protects new files", () => {
    const baseline = { "app/legacy.tsx": { "bg-black": 1 } }
    expect(
      checkSources(
        { "app/legacy.tsx": '<div className="bg-black" />' },
        baseline
      )
    ).toEqual([])
    expect(
      checkSources(
        {
          "app/legacy.tsx":
            '<div className="bg-black"><div className="bg-black" /></div>',
        },
        baseline
      )
    ).toHaveLength(1)
    expect(
      checkSources({ "app/new.tsx": '<div className="bg-black" />' }, baseline)
    ).toHaveLength(1)
  })
  test("migrated files cannot gain baseline exceptions", () => {
    expect(
      checkSources(
        { "app/(app)/sign-in/page.tsx": '<div className="bg-white" />' },
        { "app/(app)/sign-in/page.tsx": { "bg-white": 100 } }
      )
    ).toHaveLength(1)
  })
})
