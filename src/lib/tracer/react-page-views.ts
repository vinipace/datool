import { z } from "zod"
import type { PageViewResource } from "./view-resources"

export const pageViewRendererSchema = z.object({
  kind: z.enum(["react", "mdx"]),
  code: z.string().trim().min(1).max(100_000),
}).strict()

export const openPageTraceSchema = z.object({
  traceId: z.string().min(1).max(200),
  objectViewId: z.string().min(1).max(200).optional(),
  spanId: z.string().min(1).max(200).optional(),
}).strict()
export type OpenPageTrace = z.infer<typeof openPageTraceSchema>

/** Rows are the currently loaded collection, not an unbounded project query. */
export type PageViewInput = {
  page: {
    resource: PageViewResource
    queryParams: Record<string, string[]>
    total: number | null
    isLoading: boolean
    isRefreshing: boolean
    hasMore: boolean
    isLoadingMore: boolean
    error: string | null
  }
  rows: unknown[]
}
export type PageViewProps<Row = Record<string, unknown>> = Omit<PageViewInput, "rows"> & {
  rows: Row[]
  openTrace: (traceId: string, options?: Omit<OpenPageTrace, "traceId">) => void
  refresh: () => void
  loadMore: () => void
}

export const starterPageView = `import * as React from "react";
import { Button, Card, CardContent, CardHeader, CardTitle } from "@datool/ui";

export default function Page({ rows, page, openTrace, loadMore }: PageViewProps) {
  return <div className="space-y-3 p-3">
    <h2 className="text-sm font-medium">{page.resource} · {rows.length} loaded</h2>
    {rows.length === 0 && <p className="text-sm text-foreground-muted">No matching rows.</p>}
    {rows.map((row, index) => <Card key={String(row.id ?? index)}>
      <CardHeader><CardTitle>{String(row.name ?? row.id ?? "Row")}</CardTitle></CardHeader>
      <CardContent>
        <pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(row, null, 2)}</pre>
        {page.resource === "traces" && <Button className="mt-2" onClick={() => openTrace(String(row.id))}>Open trace</Button>}
      </CardContent>
    </Card>)}
    {page.hasMore && <Button disabled={page.isLoadingMore} onClick={loadMore}>Load more</Button>}
  </div>;
}`

export const starterMdxPageView = `# Collection overview

Loaded **{props.rows.length}** rows.

<Button onClick={props.refresh}>Refresh</Button>

{props.rows.length === 0 && <p>No matching rows.</p>}

<DataTable data={props.rows} columns={[{ accessorKey: "id", header: "ID" }]} />

{props.page.resource === "traces" && props.rows.map(row => (
  <TraceButton key={row.id} traceId={row.id}>{row.name ?? row.id}</TraceButton>
))}

{props.page.hasMore && <Button disabled={props.page.isLoadingMore} onClick={props.loadMore}>Load more</Button>}
`
