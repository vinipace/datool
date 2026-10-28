"use client"

import { useCallback, useState } from "react"
import { Layers, PanelsTopLeft, Plus } from "lucide-react"
import { CollectionPanel } from "@/components/tracer/collection-panel"
import {
  CollectionPage,
  CollectionSearch,
} from "@/components/tracer/collection-page"
import {
  CollectionRow,
  CollectionTable,
  CollectionTableBody,
} from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { useRemote } from "@/components/tracer/hooks"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { BuildStatus } from "../shared/build-layout"
import { buildCall, buildOperations, listItems } from "../shared/build-api"
import type { WidgetDefinition, WidgetRecord } from "@/src/lib/build/contracts"
import { WidgetEditor } from "./widget-editor"
import { WidgetTemplates } from "./widget-templates"

export function WidgetsTab({
  agentId,
  onDefinitionDirty,
}: {
  agentId: string
  onDefinitionDirty?: () => void
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      buildCall<unknown>(
        buildOperations.listWidgets,
        { agentId },
        { signal }
      ).then(listItems<WidgetRecord>),
    [agentId]
  )
  const remote = useRemote(load, [agentId])
  const [search, setSearch] = useState("")
  const [view, setView] = useState("mine")
  const [templateSearch, setTemplateSearch] = useState("")
  const [editor, setEditor] = useState<{
    widget?: WidgetRecord
    initial?: WidgetDefinition
  } | null>(null)
  const [notice, setNotice] = useState("")
  const rows = (remote.data ?? []).filter(({ definition }) =>
    `${definition.name} ${definition.description}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )
  return (
    <Tabs
      value={view}
      onValueChange={setView}
      className="flex min-h-0 w-full flex-col"
    >
      <CollectionPanel
        label="Widgets"
        navigation={
          <TabsList aria-label="Widgets">
            <TabsTrigger value="mine">
              <PanelsTopLeft className="size-4" />
              My widgets
            </TabsTrigger>
            <TabsTrigger value="templates">
              <Layers className="size-4" />
              Templates
            </TabsTrigger>
          </TabsList>
        }
      >
        <CollectionPage
          className="contents"
          state={
            view === "mine"
              ? remote
              : {
                  data: [],
                  error: null,
                  isLoading: false,
                  isRefreshing: false,
                  refresh: remote.refresh,
                }
          }
          loadingLabel="Loading widgets"
          header={{
            children: (
              <CollectionSearch
                label={view === "mine" ? "Search widgets" : "Search templates"}
                value={view === "mine" ? search : templateSearch}
                onChange={view === "mine" ? setSearch : setTemplateSearch}
              />
            ),
            actions:
              view === "mine" ? (
                <Button
                  size="sm"
                  aria-label="New widget"
                  onClick={() => {
                    setNotice("")
                    setEditor({})
                  }}
                >
                  <Plus />
                  <span className="hidden @min-[480px]/page:inline">
                    New widget
                  </span>
                </Button>
              ) : undefined,
            showRefresh: view === "mine",
            showExport: view === "mine",
            exportRows: rows,
            exportName: "widgets",
          }}
          toolbar={
            view === "mine" && notice ? (
              <Notice variant="success" role="status">
                {notice}
              </Notice>
            ) : undefined
          }
        >
          <TabsContent value="mine">
            <CollectionTable
              persistenceKey={`build-widgets:${agentId}`}
              fillHeight
              columnIds={[
                "name",
                "description",
                "components",
                "status",
                "updated",
              ]}
              widths={[240, 340, 120, 120, 180]}
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th className={collectionTable.heading}>
                    <span className="sr-only">Row number</span>
                  </th>
                  {["Widget", "Description", "Layout", "Status", "Updated"].map(
                    (title) => (
                      <th key={title} className={collectionTable.heading}>
                        {title}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <CollectionTableBody
                rows={rows}
                empty={
                  <tr>
                    <td colSpan={6} className="py-20 text-center">
                      <div className="flex flex-col items-center gap-3">
                        <PanelsTopLeft className="size-6 text-foreground-muted" />
                        <p className="text-sm font-medium">
                          {search
                            ? "No matching widgets"
                            : "Make conversations interactive"}
                        </p>
                        <p className="max-w-sm text-sm text-foreground-muted">
                          {search
                            ? "Try a different name or description."
                            : "Create cards, forms and buttons that help customers take the next step."}
                        </p>
                        {!search && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setView("templates")}
                          >
                            <Layers />
                            Browse templates
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                }
              >
                {(widget, index) => (
                  <CollectionRow
                    key={widget.id}
                    onClick={() => {
                      setNotice("")
                      setEditor({ widget })
                    }}
                  >
                    <td className={collectionTable.cell}>{index + 1}</td>
                    <td className={collectionTable.cell}>
                      <button
                        type="button"
                        className="flex max-w-full items-center gap-2 text-left"
                        onClick={() => setEditor({ widget })}
                      >
                        <PanelsTopLeft className="size-4 shrink-0 text-action-widget" />
                        <span className="truncate">
                          {widget.definition.name}
                        </span>
                      </button>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="block truncate text-foreground-muted">
                        {widget.definition.description || "—"}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      {widget.definition.code
                        ? "JSX"
                        : `${widget.definition.components.length} components`}
                    </td>
                    <td className={collectionTable.cell}>
                      <BuildStatus
                        state={widget.definition.enabled ? "active" : "paused"}
                        label={
                          widget.definition.enabled ? "Enabled" : "Disabled"
                        }
                      />
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="text-foreground-muted">
                        {new Date(widget.updatedAt).toLocaleString()}
                      </span>
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TabsContent>
          <TabsContent value="templates">
            <WidgetTemplates
              search={templateSearch}
              onClear={() => setTemplateSearch("")}
              onUse={(initial) => {
                setNotice("")
                setEditor({ initial })
              }}
            />
          </TabsContent>
        </CollectionPage>
      </CollectionPanel>
      {editor && (
        <WidgetEditor
          agentId={agentId}
          widget={editor.widget}
          initial={editor.initial}
          onClose={() => setEditor(null)}
          onSaved={(deleted) => {
            onDefinitionDirty?.()
            remote.refresh()
            setView("mine")
            setNotice(
              deleted
                ? "Widget deleted."
                : "Widget saved. Apply the agent’s changes when you’re ready to use it in customer conversations."
            )
          }}
        />
      )}
    </Tabs>
  )
}
