"use client"

import { NavigationLink as Link } from "@/components/navigation/navigation"
import { useRef, useState, type KeyboardEvent } from "react"
import {
  Boxes,
  FileText,
  Plug,
  ArrowUpRight,
  Copy,
  GitBranch,
  GitCommitHorizontal,
  ArrowUpCircle,
  Eye,
  Terminal,
} from "lucide-react"
import {
  usePathname,
  useRouter,
  useSearchParams,
} from "@/components/navigation/navigation"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  CollectionList,
  CollectionListItem,
  CollectionBadge,
} from "@/components/ui/collection-list"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { CollectionFilterBar } from "@/components/tracer/collection-filter"
import { useCollectionFilter } from "@/components/tracer/use-collection-filter"
import { formatRelative, formatDuration } from "@/components/tracer/format"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import {
  CollectionTable,
  CollectionTableBody,
  CollectionRow,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/tracer/primitives"
import { JsonCode } from "@/components/tracer/json-code"
import { useRemote } from "@/components/tracer/hooks"
import { useProjectScope } from "@/components/tracer/project-scope-context"
import { deploymentMcpPath } from "@/src/lib/deploy/urls"
import type {
  DeploymentHistory,
  DeploymentDetail,
  DeploymentTool,
  DeploymentEnvironment,
  DeploymentSummary,
} from "@/src/lib/deploy/contracts"

type Document = DeploymentDetail["documents"][number]
type BrowserProps = {
  projectId: string
  projectSlug: string
  origin: string
  deploymentId?: string
}
async function read<T>(
  projectId: string,
  query: Record<string, string>,
  signal: AbortSignal
): Promise<T> {
  const response = await fetch(
    `/api/deployments?${new URLSearchParams(query)}`,
    { headers: { "x-project-id": projectId }, signal }
  )
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? "This deployment or source is no longer available in this project."
        : "Unable to load deployment data. Try again."
    )
  return (await response.json()).data
}
const environmentLabel = (value: DeploymentEnvironment) =>
  value === "preview" ? "Preview" : "Production"
function openRow(event: KeyboardEvent<HTMLElement>) {
  if (
    event.target === event.currentTarget &&
    (event.key === "Enter" || event.key === " ")
  ) {
    event.preventDefault()
    event.currentTarget.click()
  }
}

export function ProjectDeploymentsPage(props: Omit<BrowserProps, "projectId">) {
  const scope = useProjectScope()
  return scope ? (
    <DeploymentBrowser
      key={`${scope.projectId}:${props.deploymentId ?? "history"}`}
      {...props}
      projectId={scope.projectId}
    />
  ) : null
}
export function DeploymentBrowser(props: BrowserProps) {
  return props.deploymentId ? (
    <DeploymentContents {...props} deploymentId={props.deploymentId} />
  ) : (
    <DeploymentList {...props} />
  )
}
function DeployButton({ projectSlug }: { projectSlug: string }) {
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={`/p/${encodeURIComponent(projectSlug)}/settings`}>
        <ArrowUpRight className="size-4" />
        <PanelActionLabel>Deploy from CLI</PanelActionLabel>
      </Link>
    </Button>
  )
}
function DeploymentList({ projectId, projectSlug }: BrowserProps) {
  const parameters = useSearchParams()
  const legacyEnvironment = parameters.get("environment")
  const search = useCollectionFilter(
    "deployments",
    legacyEnvironment === "preview" || legacyEnvironment === "production"
      ? `environment = "${legacyEnvironment}"`
      : ""
  )
  const [pagination, setPagination] = useState({
    filter: search.filter,
    cursors: [] as string[],
  })
  if (pagination.filter !== search.filter)
    setPagination({ filter: search.filter, cursors: [] })
  const cursors = pagination.filter === search.filter ? pagination.cursors : []
  const cursor = cursors.at(-1)
  const history = useRemote(
    (signal) =>
      read<DeploymentHistory>(
        projectId,
        {
          view: "history",
          filter: search.filter,
          ...(cursor ? { cursor } : {}),
        },
        signal
      ),
    [projectId, search.filter, cursor]
  )
  const versions = history.data?.items ?? []
  return (
    <CollectionPanel label="Deployments">
      <CollectionPage
        className="contents"
        state={history}
        loadingLabel="Loading deployments"
        header={{
          children: (
            <CollectionFilterBar
              resource="deployments"
              {...search}
              isLoading={history.isLoading || history.isRefreshing}
            />
          ),
          actions: <DeployButton projectSlug={projectSlug} />,
          showExport: false,
        }}
        isEmpty={versions.length === 0 && !cursor}
        empty={
          <EmptyState
            icon={Boxes}
            title={
              search.filter
                ? "No deployments match this filter"
                : "No deployments yet"
            }
            detail={
              search.filter
                ? "Change or clear the filter to see other deployments."
                : "Deploy a folder to Preview or Production to publish its agents, tools and sources."
            }
            action={
              search.filter ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => search.onChange("")}
                >
                  Clear filter
                </Button>
              ) : (
                <DeployButton projectSlug={projectSlug} />
              )
            }
          />
        }
      >
        <div className="@container/deployments min-w-0 flex-1 overflow-auto">
          <CollectionList aria-label="Published deployments">
            {versions.map((row) => (
              <li key={row.id}>
                <CollectionListItem
                  asChild
                  className="grid-cols-[minmax(0,1fr)_auto] @min-[840px]/deployments:grid-cols-[minmax(200px,1fr)_108px_115px_90px_minmax(110px,160px)_100px]"
                >
                  <Link
                    href={`/p/${encodeURIComponent(projectSlug)}/deployments/${row.id}`}
                    aria-label={`Open deployment ${row.title}`}
                  >
                    <span className="min-w-0">
                      <span
                        className="block truncate font-medium"
                        title={row.title}
                      >
                        {row.title}
                      </span>
                      <span className="mt-1 flex items-center gap-2 text-xs text-foreground-muted @min-[840px]/deployments:hidden">
                        <span className="font-mono">
                          {row.commit?.slice(0, 7) ?? row.id.slice(0, 8)}
                        </span>
                        {row.branch && (
                          <span className="truncate">{row.branch}</span>
                        )}
                      </span>
                    </span>
                    <span className="flex items-center gap-2 whitespace-nowrap">
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full bg-success"
                      />
                      Ready
                      {row.durationMs !== null && (
                        <span className="text-xs text-foreground-muted">
                          {formatDuration(row.durationMs)}
                        </span>
                      )}
                    </span>
                    <CollectionBadge
                      active={row.active && row.environment === "production"}
                    >
                      {row.environment === "production" ? (
                        <ArrowUpCircle className="size-3.5" />
                      ) : (
                        <Eye className="size-3.5" />
                      )}
                      {environmentLabel(row.environment)}
                    </CollectionBadge>
                    <span
                      className="hidden min-w-0 items-center gap-1.5 font-mono text-xs text-foreground-muted @min-[840px]/deployments:flex"
                      title={row.commit ?? "Deployment ID"}
                    >
                      <GitCommitHorizontal className="size-4 shrink-0" />
                      <span className="truncate">
                        {row.commit?.slice(0, 7) ?? row.id.slice(0, 8)}
                      </span>
                    </span>
                    <span
                      className="hidden min-w-0 items-center gap-2 text-xs text-foreground-muted @min-[840px]/deployments:flex"
                      title={
                        row.branch
                          ? `${row.branch}${row.dirty ? " · local changes" : ""}`
                          : "Deployed from CLI"
                      }
                    >
                      {row.branch ? (
                        <GitBranch className="size-4 shrink-0" />
                      ) : (
                        <Terminal className="size-4 shrink-0" />
                      )}
                      <span className="truncate">
                        {row.branch ?? "CLI"}
                        {row.dirty ? " *" : ""}
                      </span>
                    </span>
                    <span className="flex items-center justify-end gap-2 text-xs text-foreground-muted">
                      <time
                        dateTime={row.createdAt}
                        title={new Date(row.createdAt).toLocaleString()}
                      >
                        {formatRelative(row.createdAt)}
                      </time>
                      {row.author && (
                        <span title={row.author.name}>
                          <UserAvatarImage
                            name={row.author.name}
                            image={row.author.image}
                            size="sm"
                          />
                        </span>
                      )}
                    </span>
                  </Link>
                </CollectionListItem>
              </li>
            ))}
          </CollectionList>
        </div>
        {(cursor || history.data?.nextCursor) && (
          <div className="flex shrink-0 justify-end gap-2 py-3">
            <Button
              variant="outline"
              size="sm"
              disabled={!cursor || history.isLoading || history.isRefreshing}
              onClick={() =>
                setPagination((value) => ({
                  ...value,
                  cursors: value.cursors.slice(0, -1),
                }))
              }
            >
              Newer deployments
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !history.data?.nextCursor ||
                history.isLoading ||
                history.isRefreshing
              }
              onClick={() => {
                if (history.data?.nextCursor)
                  setPagination((value) => ({
                    ...value,
                    cursors: [...value.cursors, history.data!.nextCursor!],
                  }))
              }}
            >
              Older deployments
            </Button>
          </div>
        )}
      </CollectionPage>
    </CollectionPanel>
  )
}

function DeploymentContents({
  projectId,
  projectSlug,
  origin,
  deploymentId,
}: BrowserProps & { deploymentId: string }) {
  const router = useRouter(),
    pathname = usePathname(),
    parameters = useSearchParams()
  const tab = parameters.get("tab") === "sources" ? "sources" : "tools"
  const [search, setSearch] = useState("")
  const [inspectedTool, setInspectedTool] = useState<DeploymentTool | null>(
    null
  )
  const [inspectedSource, setInspectedSource] = useState<Document | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const restoreFocus = (event: Event) => {
    event.preventDefault()
    returnFocus.current?.focus()
  }
  const detail = useRemote(
    (signal) =>
      read<DeploymentDetail>(
        projectId,
        { view: "detail", id: deploymentId },
        signal
      ),
    [projectId, deploymentId]
  )
  const current = detail.data?.deployment
  const tools = (detail.data?.tools ?? []).filter((tool) =>
    `${tool.name} ${tool.description}`
      .toLowerCase()
      .includes(search.toLowerCase())
  )
  const documents = (detail.data?.documents ?? []).filter((doc) =>
    `${doc.title} ${doc.path}`.toLowerCase().includes(search.toLowerCase())
  )
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => {
        router.replaceQuery(
          `${pathname}${value === "sources" ? "?tab=sources" : ""}`
        )
        setSearch("")
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <CollectionPanel label="Deployment contents">
        <CollectionPage
          className="contents"
          state={detail}
          loadingLabel="Loading deployment"
          header={{
            children: (
              <>
                <TabsList aria-label="Deployment contents">
                  <TabsTrigger value="tools">
                    <Plug className="size-4" />
                    MCP tools
                  </TabsTrigger>
                  <TabsTrigger value="sources">
                    <FileText className="size-4" />
                    Sources
                  </TabsTrigger>
                </TabsList>
                <CollectionSearch
                  label={tab === "tools" ? "Search tools" : "Search sources"}
                  value={search}
                  onChange={setSearch}
                />
              </>
            ),
            actions: current ? (
              <McpConnection
                deployment={current}
                origin={origin}
                projectSlug={projectSlug}
              />
            ) : undefined,
            showExport: false,
          }}
        >
          <TabsContent
            value="tools"
            className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <CollectionTable
              widths={[280, 540]}
              columnIds={["tool", "description"]}
              persistenceKey="deployment-tools"
              fillHeight
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th aria-hidden className={collectionTable.heading} />
                  <th className={collectionTable.heading}>Tool</th>
                  <th className={collectionTable.heading}>Description</th>
                </tr>
              </thead>
              <CollectionTableBody
                rows={tools.map((tool) => ({ ...tool, id: tool.name }))}
                empty={
                  <tr>
                    <td
                      colSpan={3}
                      className="py-10 text-center text-foreground-muted"
                    >
                      {search
                        ? "No tools match this search."
                        : "This deployment has no MCP tools."}
                    </td>
                  </tr>
                }
              >
                {(tool) => (
                  <CollectionRow
                    rowLabel={tool.name}
                    aria-label={`Inspect ${tool.name}`}
                    tabIndex={0}
                    onKeyDown={openRow}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget
                      setInspectedTool(tool)
                    }}
                  >
                    <td aria-hidden className={collectionTable.cell} />
                    <td className={collectionTable.cell}>
                      <span className="font-mono">{tool.name}</span>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="block truncate text-foreground-muted">
                        {tool.description}
                      </span>
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TabsContent>
          <TabsContent
            value="sources"
            className="min-h-0 flex-1 data-[state=active]:flex data-[state=active]:flex-col"
          >
            <CollectionTable
              widths={[240, 320, 110, 120]}
              columnIds={["title", "path", "kind", "characters"]}
              persistenceKey="deployment-sources"
              fillHeight
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th aria-hidden className={collectionTable.heading} />
                  {["Title", "Path", "Kind", "Characters"].map((label) => (
                    <th key={label} className={collectionTable.heading}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <CollectionTableBody
                rows={documents.map((doc) => ({
                  ...doc,
                  id: `${doc.kind}:${doc.path}`,
                }))}
                empty={
                  <tr>
                    <td
                      colSpan={5}
                      className="py-10 text-center text-foreground-muted"
                    >
                      {search
                        ? "No sources match this search."
                        : "This deployment has no sources or skills."}
                    </td>
                  </tr>
                }
              >
                {(doc) => (
                  <CollectionRow
                    rowLabel={doc.title}
                    aria-label={`Read ${doc.title}`}
                    tabIndex={0}
                    onKeyDown={openRow}
                    onClick={(event) => {
                      returnFocus.current = event.currentTarget
                      setInspectedSource(doc)
                    }}
                  >
                    <td aria-hidden className={collectionTable.cell} />
                    <td className={collectionTable.cell}>{doc.title}</td>
                    <td className={collectionTable.cell}>
                      <span className="block truncate font-mono text-xs text-foreground-muted">
                        {doc.path}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      {doc.kind === "skill" ? "Skill" : "Source"}
                    </td>
                    <td className={collectionTable.cell}>
                      {doc.characters.toLocaleString()}
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TabsContent>
        </CollectionPage>
      </CollectionPanel>
      <Dialog
        open={Boolean(inspectedTool)}
        onOpenChange={(open) => {
          if (!open) setInspectedTool(null)
        }}
      >
        <DialogContent variant="panel" onCloseAutoFocus={restoreFocus}>
          <DialogHeader>
            <DialogTitle>{inspectedTool?.name}</DialogTitle>
            <DialogDescription>{inspectedTool?.description}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-auto">
            <h3 className="mb-3 text-sm font-medium">Input schema</h3>
            <pre className="text-sm break-words whitespace-pre-wrap">
              <JsonCode
                text={JSON.stringify(inspectedTool?.inputSchema ?? {}, null, 2)}
              />
            </pre>
          </div>
        </DialogContent>
      </Dialog>
      {inspectedSource && (
        <SourcePreview
          projectId={projectId}
          deploymentId={deploymentId}
          document={inspectedSource}
          onClose={() => setInspectedSource(null)}
          onRestoreFocus={restoreFocus}
        />
      )}
    </Tabs>
  )
}
function McpConnection({
  deployment,
  origin,
  projectSlug,
}: {
  deployment: DeploymentSummary
  origin: string
  projectSlug: string
}) {
  const [copyStatus, setCopyStatus] = useState("")
  const [endpoint, setEndpoint] = useState("production")
  const production =
    deployment.environment === "production" && endpoint === "production"
  const url =
    origin +
    (production ? deployment.mcpPath : deploymentMcpPath(deployment.id))
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Plug className="size-4" />
          <PanelActionLabel>Connect MCP</PanelActionLabel>
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Connect to {environmentLabel(deployment.environment)}
          </DialogTitle>
          <DialogDescription>
            {production
              ? "Always connects to the latest production deployment."
              : "Connects to this deployment, even after a newer version is published."}
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={endpoint}
          onValueChange={(value) => {
            setEndpoint(value)
            setCopyStatus("")
          }}
          className="space-y-3"
        >
          {deployment.environment === "production" && (
            <TabsList aria-label="MCP endpoint">
              <TabsTrigger value="production">Production</TabsTrigger>
              <TabsTrigger value="deployment">This deployment</TabsTrigger>
            </TabsList>
          )}
          <TabsContent value={endpoint} className="space-y-2">
            <label htmlFor="deployment-mcp-url" className="text-sm">
              MCP server URL
            </label>
            <div className="flex gap-2">
              <Input
                id="deployment-mcp-url"
                value={url}
                readOnly
                className="min-w-0 font-mono text-xs"
              />
              <Button
                size="icon"
                variant="outline"
                aria-label="Copy MCP URL"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(url)
                    setCopyStatus("MCP URL copied.")
                  } catch {
                    setCopyStatus("Select the URL to copy it.")
                  }
                }}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </TabsContent>
        </Tabs>
        <p className="text-sm text-foreground-muted">
          Sign in with your MCP client, or use an API key with Build read and
          run access.
        </p>
        <Button asChild size="sm" variant="outline">
          <Link
            href={`/p/${encodeURIComponent(projectSlug)}/settings/api-keys`}
          >
            Manage API keys
          </Link>
        </Button>
        {copyStatus && (
          <p role="status" className="text-xs text-foreground-muted">
            {copyStatus}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}
function SourcePreview({
  projectId,
  deploymentId,
  document,
  onClose,
  onRestoreFocus,
}: {
  projectId: string
  deploymentId: string
  document: Document
  onClose: () => void
  onRestoreFocus: (event: Event) => void
}) {
  const source = useRemote(
    (signal) =>
      read<{ text: string }>(
        projectId,
        {
          view: "source",
          id: deploymentId,
          kind: document.kind,
          path: document.path,
        },
        signal
      ),
    [projectId, deploymentId, document.kind, document.path]
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent variant="panel" onCloseAutoFocus={onRestoreFocus}>
        <DialogHeader>
          <DialogTitle>{document.title}</DialogTitle>
          <DialogDescription className="break-all">
            {document.path} · published snapshot
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-auto">
          {source.isLoading ? (
            <LoadingState label="Loading source" />
          ) : source.error ? (
            <ErrorState error={source.error} onRetry={source.refresh} />
          ) : (
            <pre className="font-mono text-sm leading-6 break-words whitespace-pre-wrap">
              {source.data?.text}
            </pre>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
