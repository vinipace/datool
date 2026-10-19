import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import {
  createMemoryNavigation,
  NavigationLink,
  NavigationProvider,
  useNavigation,
} from "@/components/navigation/navigation"

test("embedded navigation restores filters and span deep links without changing the host page", () => {
  const list = "/p/demo/traces?filter=status%3D%22errored%22"
  const detail = `${list}&trace=t1&span=s2`
  const navigation = createMemoryNavigation(list)
  navigation.router.push(`${list}&trace=t1`)
  navigation.router.replace(detail)
  navigation.router.back()
  expect(navigation.getSnapshot()).toBe(list)
  navigation.router.back()
  expect(navigation.getSnapshot()).toBe(list)
  navigation.router.forward()
  expect(navigation.getSnapshot()).toBe(detail)
  navigation.router.replaceQuery(`${detail}&tab=timeline`)
  navigation.router.back()
  navigation.router.push(`${list}&trace=t2`)
  navigation.router.forward()
  expect(navigation.getSnapshot()).toBe(`${list}&trace=t2`)
})

test("shared components receive the embedded route and unsupported pages link to Datool", () => {
  const navigation = createMemoryNavigation("/p/demo/traces/t1?span=s1", {
    origin: "https://www.trydatool.com",
    accepts: (pathname) => pathname.startsWith("/p/demo/traces"),
  })
  function Page() {
    const { pathname, searchParams } = useNavigation()
    return (
      <div>
        {pathname} / {searchParams.get("span")}
        <NavigationLink href="/p/demo/traces/t2">Trace</NavigationLink>
        <NavigationLink href="/p/demo/evals/run-1">Evaluation</NavigationLink>
      </div>
    )
  }
  const html = renderToStaticMarkup(
    <NavigationProvider adapter={navigation}>
      <Page />
    </NavigationProvider>
  )
  expect(html).toContain("/p/demo/traces/t1 / s1")
  expect(html).toContain('href="/p/demo/traces/t2"')
  expect(html).toContain('href="https://www.trydatool.com/p/demo/evals/run-1"')
  for (const path of [
    "/p/demo/evals/run-1",
    "//outside.test/",
    "/\\outside.test/",
    "javascript:alert(1)",
  ])
    expect(() => navigation.router.push(path)).toThrow()
  expect(navigation.resolveHref?.("javascript:alert(1)")).toBe("#")
  expect(navigation.getSnapshot()).toBe("/p/demo/traces/t1?span=s1")
})
