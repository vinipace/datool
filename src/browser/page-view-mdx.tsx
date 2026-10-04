import * as React from "react"
import type { MDXComponents } from "mdx/types"
import type { PageViewProps } from "../lib/tracer/react-page-views"
import type { ObjectViewProps } from "../lib/tracer/object-views"
import * as ui from "./trace-view-ui"

const PageContext = React.createContext<PageViewProps<unknown> | null>(null)

function TraceButton({ traceId, objectViewId, spanId, children, ...props }: React.ComponentProps<typeof ui.Button> & {
  traceId: string
  objectViewId?: string
  spanId?: string
}) {
  const page = React.useContext(PageContext)
  return <ui.Button {...props} onClick={() => page?.openTrace(traceId, { objectViewId, spanId })}>
    {children ?? "Open trace"}
  </ui.Button>
}

const components: MDXComponents = { ...ui, TraceButton }

/** Markdown and JSX share the same sandbox and collection actions as React pages. */
export function MdxPageContent({ Component, input }: {
  Component: React.ComponentType<(PageViewProps<unknown> | ObjectViewProps) & { components?: MDXComponents }>
  input: PageViewProps<unknown>
}) {
  return <PageContext.Provider value={input}>
    <div className="space-y-3 p-3 text-sm [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:text-lg [&_h2]:font-medium [&_h3]:font-medium [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_a]:text-primary [&_a]:underline [&_pre]:overflow-auto [&_pre]:rounded [&_pre]:bg-muted [&_pre]:p-3 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-foreground-muted [&_table]:w-full [&_th]:text-left [&_th]:p-2 [&_td]:p-2 [&_tr]:border-b [&_tr]:border-border">
      <Component {...input} components={components} />
    </div>
  </PageContext.Provider>
}
