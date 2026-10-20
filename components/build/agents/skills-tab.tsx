"use client"

import { useState } from "react"
import {
  BookOpen,
  CalendarDays,
  Clock3,
  CreditCard,
  Headset,
  Layers,
  Plus,
  RotateCcw,
  ArrowLeftRight,
  type LucideIcon,
} from "lucide-react"
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
import { Card, CardAction } from "@/components/ui/card"
import { Notice } from "@/components/ui/notice"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type {
  ProcedureDefinition,
  ProcedureRecord,
} from "@/src/lib/build/contracts"
import {
  skillFromTemplate,
  skillTemplates,
  type SkillTemplate,
} from "@/src/lib/build/skill-templates"
import { BuildStatus } from "../shared/build-layout"
import { buildCall, buildOperations, listItems } from "../shared/build-api"
import { SkillEditor } from "./skill-editor"

const templateIcons: Record<string, LucideIcon> = {
  "support-hours": Clock3,
  "live-agent": Headset,
  "product-exchange": ArrowLeftRight,
  "order-refund": RotateCcw,
  "billing-dispute": CreditCard,
  "lead-meeting": CalendarDays,
}

function blankSkill(): ProcedureDefinition {
  return {
    name: "",
    description: "",
    enabled: false,
    trigger: { type: "intent", value: "" },
    instructions: "",
    steps: [],
    variables: {},
    branches: [],
    actionRefs: [],
  }
}

export function SkillsTab({
  agentId,
  active,
  onDefinitionDirty,
}: {
  agentId: string
  active: boolean
  onDefinitionDirty?: () => void
}) {
  const remote = useRemote(
    (signal) =>
      buildCall<unknown>(
        buildOperations.listProcedures,
        { agentId },
        { signal }
      ).then(listItems<ProcedureRecord>),
    [agentId],
    { enabled: active }
  )
  const [view, setView] = useState("mine")
  const [search, setSearch] = useState("")
  const [templateSearch, setTemplateSearch] = useState("")
  const [preview, setPreview] = useState<SkillTemplate | null>(null)
  const [editor, setEditor] = useState<{
    record?: ProcedureRecord
    initial: ProcedureDefinition
    suggestedActions?: string[]
  } | null>(null)
  const [notice, setNotice] = useState("")
  const rows = (remote.data ?? []).filter(({ definition }) =>
    `${definition.name} ${definition.description} ${definition.trigger.value}`
      .toLowerCase()
      .includes(search.trim().toLowerCase())
  )
  const templates = skillTemplates.filter((template) =>
    `${template.name} ${template.description} ${template.category} ${template.trigger}`
      .toLowerCase()
      .includes(templateSearch.trim().toLowerCase())
  )
  function create() {
    setNotice("")
    setEditor({ initial: blankSkill() })
  }
  function edit(record: ProcedureRecord) {
    setNotice("")
    setEditor({ record, initial: record.definition })
  }
  return (
    <Tabs
      value={view}
      onValueChange={setView}
      className="flex min-h-0 w-full flex-col"
    >
      <CollectionPanel
        label="Skills"
        navigation={
          <TabsList aria-label="Skills">
            <TabsTrigger value="mine">
              <BookOpen className="size-4" />
              My skills
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
                  data: templates,
                  error: null,
                  isLoading: false,
                  isRefreshing: false,
                  refresh: remote.refresh,
                }
          }
          loadingLabel="Loading skills"
          header={{
            children: (
              <CollectionSearch
                label={view === "mine" ? "Search skills" : "Search templates"}
                value={view === "mine" ? search : templateSearch}
                onChange={view === "mine" ? setSearch : setTemplateSearch}
              />
            ),
            actions:
              view === "mine" ? (
                <Button size="sm" onClick={create}>
                  <Plus />
                  New skill
                </Button>
              ) : undefined,
            showRefresh: view === "mine",
            showExport: view === "mine",
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
              persistenceKey={`build-skills:${agentId}`}
              columnIds={["name", "trigger", "status", "revision"]}
              widths={[280, 440, 120, 90]}
            >
              <thead className={collectionTable.head}>
                <tr>
                  <th className={collectionTable.heading}>
                    <span className="sr-only">Row number</span>
                  </th>
                  {["Skill", "When to use", "Status", "Revision"].map(
                    (label) => (
                      <th key={label} className={collectionTable.heading}>
                        {label}
                      </th>
                    )
                  )}
                </tr>
              </thead>
              <CollectionTableBody
                rows={rows}
                empty={
                  <tr>
                    <td colSpan={5} className="px-4 py-20 text-center">
                      <div className="mx-auto flex max-w-sm flex-col items-center gap-3">
                        <BookOpen className="size-7 text-foreground-muted" />
                        <p className="text-sm font-medium">
                          {search
                            ? "No matching skills"
                            : "Teach your agent a skill"}
                        </p>
                        <p className="text-sm leading-6 text-foreground-muted">
                          {search
                            ? "Try another name or trigger."
                            : "Give your agent reusable instructions for refunds, support handoffs, sales and more."}
                        </p>
                        {search ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setSearch("")}
                          >
                            Clear search
                          </Button>
                        ) : (
                          <Button
                            variant="outline"
                            size="sm"
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
                {(record, index) => (
                  <CollectionRow key={record.id} onClick={() => edit(record)}>
                    <td className={collectionTable.cell}>{index + 1}</td>
                    <td className={collectionTable.cell}>
                      <button
                        type="button"
                        className="flex max-w-full items-center gap-2 text-left"
                        onClick={() => edit(record)}
                      >
                        <BookOpen className="size-4 shrink-0 text-foreground-muted" />
                        <span className="truncate">
                          {record.definition.name}
                        </span>
                      </button>
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="block truncate text-foreground-muted">
                        {record.definition.trigger.value}
                      </span>
                    </td>
                    <td className={collectionTable.cell}>
                      <BuildStatus
                        state={record.definition.enabled ? "active" : "paused"}
                        label={
                          record.definition.enabled ? "Enabled" : "Disabled"
                        }
                      />
                    </td>
                    <td className={collectionTable.cell}>
                      <span className="text-foreground-muted">
                        v{record.revision}
                      </span>
                    </td>
                  </CollectionRow>
                )}
              </CollectionTableBody>
            </CollectionTable>
          </TabsContent>
          <TabsContent value="templates" className="space-y-6 pt-4 pb-6">
            {(["Support", "E-commerce", "Billing", "Sales"] as const).map(
              (category) => {
                const group = templates.filter(
                  (template) => template.category === category
                )
                return group.length ? (
                  <section
                    key={category}
                    aria-label={`${category} templates`}
                    className="space-y-3"
                  >
                    <h2 className="text-sm font-medium">{category}</h2>
                    <div className="grid gap-3 lg:grid-cols-2">
                      {group.map((template) => {
                        const Icon = templateIcons[template.id] ?? BookOpen
                        return (
                          <Card key={template.id}>
                            <CardAction
                              className="flex h-full items-start gap-4"
                              onClick={() => setPreview(template)}
                            >
                              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground-muted">
                                <Icon className="size-5" aria-hidden />
                              </span>
                              <span className="min-w-0 space-y-1">
                                <span className="block text-sm font-medium">
                                  {template.name}
                                </span>
                                <span className="block text-sm leading-6 text-foreground-muted">
                                  {template.description}
                                </span>
                              </span>
                            </CardAction>
                          </Card>
                        )
                      })}
                    </div>
                  </section>
                ) : null
              }
            )}
            {!templates.length ? (
              <div className="py-16 text-center">
                <p className="text-sm text-foreground-muted">
                  No matching templates.
                </p>
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-3"
                  onClick={() => setTemplateSearch("")}
                >
                  Clear search
                </Button>
              </div>
            ) : null}
          </TabsContent>
        </CollectionPage>
      </CollectionPanel>
      {preview ? (
        <Sheet
          open
          onOpenChange={(open) => {
            if (!open) setPreview(null)
          }}
        >
          <SheetContent>
            <SheetHeader className="shrink-0 border-b border-border p-5">
              <span className="mb-2 w-fit rounded-md border border-border px-2 py-1 text-xs text-foreground-muted">
                {preview.category}
              </span>
              <SheetTitle>{preview.name}</SheetTitle>
              <SheetDescription className="leading-6">
                {preview.description}
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 space-y-6 overflow-auto p-5 text-sm">
              <section className="space-y-2">
                <h3 className="font-medium">When to use</h3>
                <p className="leading-6 text-foreground-muted">
                  {preview.trigger}
                </p>
              </section>
              <section className="space-y-3">
                <h3 className="font-medium">Instructions</h3>
                <ol className="list-decimal space-y-4 pl-5 leading-6 marker:text-foreground-muted">
                  {preview.steps.map((step) => (
                    <li key={step} className="pl-1">
                      {step}
                    </li>
                  ))}
                </ol>
              </section>
              <section className="space-y-3">
                <h3 className="font-medium">Suggested actions</h3>
                <div className="flex flex-wrap gap-2">
                  {preview.suggestedActions.map((action) => (
                    <span
                      key={action}
                      className="rounded-md border border-border bg-muted px-2 py-1 text-xs"
                    >
                      {action}
                    </span>
                  ))}
                </div>
                <p className="text-xs leading-5 text-foreground-muted">
                  Link your own actions and adapt this template to your
                  business. Using a template opens an editable, disabled draft.
                </p>
              </section>
            </div>
            <SheetFooter className="shrink-0 border-t border-border p-5">
              <Button
                onClick={() => {
                  setEditor({
                    initial: skillFromTemplate(preview),
                    suggestedActions: preview.suggestedActions,
                  })
                  setPreview(null)
                }}
              >
                <Plus />
                Use template
              </Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>
      ) : null}
      {editor ? (
        <SkillEditor
          agentId={agentId}
          {...editor}
          onClose={() => setEditor(null)}
          onSaved={(deleted) => {
            onDefinitionDirty?.()
            remote.refresh()
            setView("mine")
            setNotice(deleted ? "Skill deleted." : "Skill saved.")
          }}
        />
      ) : null}
    </Tabs>
  )
}
