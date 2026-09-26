import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { InspectorGroupMembership } from "@/components/tracer/inspector-group-membership"
import {
  parseFilterQuery,
  type FilterComparisonClause,
} from "@/components/ui/datool/search-bar/filter-query"
import ProjectAgentsPage from "@/app/(app)/p/[projectSlug]/agents/page"
import ProjectWorkflowsPage from "@/app/(app)/p/[projectSlug]/workflows/page"

test("details show only the selected group and open its exact bounded performance query", async () => {
  const [rootHtml, spanHtml] = [true, false].map((isRootSelected) =>
    renderToStaticMarkup(
      <InspectorGroupMembership
        traceGroup={{
          type: "workflow",
          name: 'Research "brands"',
          version: "v1",
        }}
        spanGroup={{ type: "agent", name: "Extractor" }}
        isRootSelected={isRootSelected}
        workspaceHref={(path) => `/p/prod${path}`}
      />
    )
  )
  expect(rootHtml).toContain("Workflow: Research &quot;brands&quot;")
  expect(rootHtml).not.toContain("Agent: Extractor")
  expect(spanHtml).toContain("Agent: Extractor")
  expect(spanHtml).not.toContain("Workflow: Research &quot;brands&quot;")
  const html = rootHtml + spanHtml
  expect(html).not.toContain("Trace group")
  expect(html).not.toContain("Span group")
  expect(html).not.toContain("Unversioned")
  expect(html).toContain("/p/prod/workflows?filter=")
  expect(html).toContain("/p/prod/agents?filter=")
  const links = Array.from(
    html.matchAll(/href="([^"]+)"/g),
    (match) => new URL(match[1].replaceAll("&amp;", "&"), "http://localhost")
  )
  expect(links).toHaveLength(2)
  const filters = links.map((link) =>
    parseFilterQuery(link.searchParams.get("filter")!).filter(
      (clause): clause is FilterComparisonClause => !("text" in clause)
    )
  )
  // Group links must carry the page's bounded time range as well as identity;
  // an identity-only filter replaces the default and requests all-time metrics.
  for (const clauses of filters) {
    expect(
      clauses.find((clause) => clause.path[0] === "startedAt")
    ).toMatchObject({ operator: ">=", value: "-7d" })
  }
  expect(filters[0].find((clause) => clause.path[0] === "name")?.value).toBe(
    'Research "brands"'
  )
  expect(filters[0].find((clause) => clause.path[0] === "version")?.value).toBe(
    "v1"
  )
  expect(
    filters[1].find((clause) => clause.path[0] === "version")?.value
  ).toBeNull()
  for (const [index, Page] of [
    ProjectWorkflowsPage,
    ProjectAgentsPage,
  ].entries()) {
    const filter = links[index].searchParams.get("filter")!
    const page = await Page({
      params: Promise.resolve({ projectSlug: "prod" }),
      searchParams: Promise.resolve({ filter }),
    })
    expect(page.props.initialFilter).toBe(filter)
    expect(page.props.model).toBe(index === 0 ? "workflows" : "agents")
  }
})

test("missing selected membership hides the whole section without falling back to another group", () => {
  for (const isRootSelected of [true, false]) {
    const html = renderToStaticMarkup(
      <InspectorGroupMembership
        traceGroup={
          isRootSelected ? null : { type: "workflow", name: "Research" }
        }
        spanGroup={isRootSelected ? { type: "agent", name: "Extractor" } : null}
        isRootSelected={isRootSelected}
        workspaceHref={(path) => path}
      />
    )
    expect(html).toBe("")
  }
})
