import * as React from "react"
import { createPortal } from "react-dom"
import type { Meta, StoryObj } from "@storybook/nextjs-vite"
import { expect, within } from "storybook/test"
import { defaultTableSettings } from "@/src/lib/tracer/custom-views"
import { starterMdxPageView } from "@/src/lib/tracer/react-page-views"
import type { ViewSourceFormat } from "@/src/lib/tracer/trace-view-contract"
import { ReactPageView } from "./react-page-view"
import { PageViewDataSource, PageViewSurface } from "./page-view-surface"
import { PageViewSurfaceContext, emptyPageViewData, type PageViewCollectionData } from "./page-view-surface-context"
import { ProjectScope } from "./project-scope-context"

const code = `import * as React from "react";
export default function Page({ rows, page }: PageViewProps<{ id: string; name: string }>) {
  return <main className="space-y-3 p-4">
    <h1>Review queue</h1>
    {page.isLoading ? <p>Loading rows…</p> : rows.length === 0 ? <p>No traces to review.</p> :
      rows.map(row => <article key={row.id} className="rounded border border-border bg-muted p-3">{row.name}</article>)}
  </main>;
}`
const settings = { ...defaultTableSettings, schemaVersion: 1 as const, computedColumns: [], columnOrder: [], detailsOpen: false }

function RendererSlot({ source, format }: { source: string; format: ViewSourceFormat }) {
  const surface = React.useContext(PageViewSurfaceContext)
  const setActive = surface?.setActive
  React.useEffect(() => {
    setActive?.(true)
    return () => setActive?.(false)
  }, [setActive])
  return surface?.target ? createPortal(
    <ReactPageView code={source} format={format} resource="traces" settings={settings} />,
    surface.target
  ) : null
}

function Example({ source = code, format = "react", data = emptyPageViewData }: { source?: string; format?: ViewSourceFormat; data?: PageViewCollectionData }) {
  return <ProjectScope.Provider value={{ projectId: "storybook-project", organizationId: "storybook-organization" }}>
    <div className="flex h-[480px] flex-col border border-border bg-background">
      <PageViewSurface>
        <PageViewDataSource data={data} />
        <RendererSlot source={source} format={format} />
        <p>Default collection content</p>
      </PageViewSurface>
    </div>
  </ProjectScope.Provider>
}

const meta = {
  title: "Tracer/ReactPageView",
  component: ReactPageView,
  args: { code, resource: "traces", settings },
  render: () => <Example />,
} satisfies Meta<typeof ReactPageView>
export default meta
type Story = StoryObj<typeof meta>

export const EmptyRows: Story = {
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByTitle("React view preview")).resolves.toBeVisible()
    await expect(within(canvasElement).getByText("Default collection content")).not.toBeVisible()
  },
}
export const LoadedRows: Story = {
  render: () => <Example data={{ ...emptyPageViewData, total: 2, rows: [
    { id: "one", name: "Answer awaiting review" }, { id: "two", name: "Tool call awaiting review" },
  ] }} />,
}
export const LoadingRows: Story = {
  render: () => <Example data={{ ...emptyPageViewData, isLoading: true }} />,
}
export const RuntimeError: Story = {
  render: () => <Example source={'export default function Page() { throw new Error("Review queue unavailable") }'} />,
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).findByRole("alert")).resolves.toHaveTextContent("Review queue unavailable")
  },
}
export const MdxDocument: Story = {
  render: () => <Example format="mdx" source={starterMdxPageView} data={{ ...emptyPageViewData, total: 2, rows: [
    { id: "one", name: "Answer awaiting review" }, { id: "two", name: "Tool call awaiting review" },
  ] }} />,
}
