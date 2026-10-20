"use client"

import { useCallback, useState } from "react"
import { ChevronDown, MousePointer2, Plus, Trash2, Zap } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Combobox } from "@/components/ui/combobox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Notice } from "@/components/ui/notice"
import { CodeEditor } from "@/components/ui/code-editor"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { useRemote } from "@/components/tracer/hooks"
import type { ActionRecord, WidgetDefinition } from "@/src/lib/build/contracts"
import { buildCall, buildOperations, listItems } from "../shared/build-api"
import { ActionTypeLabel, ActionIcon } from "./action-catalog"

type WidgetFunction = WidgetDefinition["functions"][number]

export function WidgetFunctions({
  agentId,
  functions,
  onChange,
  onInsert,
}: {
  agentId: string
  functions: WidgetFunction[]
  onChange: (functions: WidgetFunction[]) => void
  onInsert: (fn: WidgetFunction, kind: "button" | "form") => void
}) {
  const load = useCallback(
    (signal: AbortSignal) =>
      buildCall<unknown>(
        buildOperations.listActions,
        { agentId },
        { signal }
      ).then(listItems<ActionRecord>),
    [agentId]
  )
  const remote = useRemote(load, [agentId])
  const [expanded, setExpanded] = useState(0)
  const actions = remote.data ?? []
  function update(index: number, value: Partial<WidgetFunction>) {
    onChange(functions.map((fn, i) => (i === index ? { ...fn, ...value } : fn)))
  }
  function add() {
    let index = functions.length + 1
    while (functions.some((fn) => fn.name === `function${index}`)) index++
    setExpanded(functions.length)
    onChange([
      ...functions,
      {
        name: `function${index}`,
        actionId: null,
        inputSchema: {},
        outputSchema: {},
      },
    ])
  }
  return (
    <div className="h-full overflow-y-auto p-5">
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-sm font-medium">Functions</h2>
          <p className="mt-1 max-w-md text-xs leading-relaxed text-foreground-muted">
            Connect an agent action, then add it to a button or form. Manage API
            endpoints and credentials in Actions.
          </p>
        </div>
        {functions.length > 0 && (
          <Button
            size="sm"
            variant="outline"
            onClick={add}
            disabled={functions.length >= 100}
          >
            <Plus />
            Add function
          </Button>
        )}
      </div>
      {remote.error && (
        <Notice variant="error">
          {remote.error.message}
          <Button size="sm" variant="ghost" onClick={remote.refresh}>
            Retry
          </Button>
        </Notice>
      )}
      {!functions.length ? (
        <div className="flex min-h-80 flex-col items-center justify-center gap-3 text-center">
          <Zap className="size-7 text-foreground-muted" />
          <h3 className="text-sm font-medium">
            Give your widget something to do
          </h3>
          <p className="max-w-xs text-sm text-foreground-muted">
            Look up an order, submit a form, or connect a customer to your team.
          </p>
          <Button size="sm" variant="outline" onClick={add}>
            <Plus />
            Add your first function
          </Button>
        </div>
      ) : (
        <div className="space-y-3">
          {functions.map((fn, index) => {
            const action = actions.find(
              (item) => item.id === fn.actionId
            )?.definition
            return (
              <section
                key={index}
                className="overflow-hidden rounded-lg border border-border"
              >
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-between rounded-none px-4 py-3"
                  aria-expanded={expanded === index}
                  onClick={() => setExpanded(expanded === index ? -1 : index)}
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Zap className="size-4 text-action-widget" />
                    <span className="truncate">
                      {fn.name || "Untitled function"}
                    </span>
                  </span>
                  <ChevronDown className="size-4" />
                </Button>
                {expanded === index && (
                  <div className="space-y-5 border-t border-border p-4">
                    <div className="space-y-2">
                      <Label htmlFor={`function-name-${index}`}>
                        Function name
                      </Label>
                      <Input
                        id={`function-name-${index}`}
                        value={fn.name}
                        maxLength={120}
                        onChange={(e) =>
                          update(index, { name: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Agent action</Label>
                      <Combobox
                        label={`Action for ${fn.name}`}
                        value={fn.actionId}
                        placeholder={
                          remote.isLoading
                            ? "Loading actions…"
                            : "Connect an action…"
                        }
                        options={actions
                          .filter((item) => item.definition.type !== "widget")
                          .map((item) => ({
                            value: item.id,
                            label: item.definition.name,
                            leading: (
                              <ActionIcon
                                type={item.definition.type}
                                size="sm"
                              />
                            ),
                            description: item.definition.enabled
                              ? item.definition.description
                              : "Disabled action",
                            disabled: !item.definition.enabled,
                          }))}
                        selectedOption={
                          fn.actionId && !action
                            ? {
                                value: fn.actionId,
                                label: remote.isLoading
                                  ? "Loading action…"
                                  : "Unavailable action",
                              }
                            : undefined
                        }
                        onValueChange={(id) => {
                          const definition = actions.find(
                            (item) => item.id === id
                          )!.definition
                          update(index, {
                            actionId: id,
                            inputSchema: definition.inputSchema,
                            outputSchema:
                              definition.type === "http"
                                ? definition.responseSchema
                                : "resultSchema" in definition
                                  ? definition.resultSchema
                                  : {},
                          })
                        }}
                      />
                    </div>
                    {action && (
                      <div className="space-y-2 rounded-md border border-border bg-muted p-3 text-xs">
                        <ActionTypeLabel type={action.type} />
                        {action.type === "http" && (
                          <p className="font-mono break-all text-foreground-muted">
                            {action.method} {action.url}
                          </p>
                        )}
                        {action.description && (
                          <p className="text-foreground-muted">
                            {action.description}
                          </p>
                        )}
                        {!action.enabled && (
                          <p className="text-warning">
                            This action is disabled. Enable it in Actions before
                            using this function.
                          </p>
                        )}
                      </div>
                    )}
                    <Tabs defaultValue="input">
                      <TabsList>
                        <TabsTrigger value="input">Inputs</TabsTrigger>
                        <TabsTrigger value="output">Return schema</TabsTrigger>
                      </TabsList>
                      <TabsContent value="input" className="mt-2">
                        <CodeEditor
                          label={`Inputs for ${fn.name}`}
                          value={JSON.stringify(fn.inputSchema, null, 2)}
                          onChange={() => {}}
                          language="json"
                          readOnly
                          className="h-44"
                        />
                      </TabsContent>
                      <TabsContent value="output" className="mt-2">
                        <CodeEditor
                          label={`Return schema for ${fn.name}`}
                          value={JSON.stringify(fn.outputSchema, null, 2)}
                          onChange={() => {}}
                          language="json"
                          readOnly
                          className="h-44"
                        />
                      </TabsContent>
                    </Tabs>
                    <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Delete function ${fn.name}`}
                        onClick={() =>
                          onChange(functions.filter((_, i) => index !== i))
                        }
                      >
                        <Trash2 />
                        Remove
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!fn.actionId || !action?.enabled}
                        onClick={() => onInsert(fn, "button")}
                      >
                        <MousePointer2 />
                        Insert button
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!fn.actionId || !action?.enabled}
                        onClick={() => onInsert(fn, "form")}
                      >
                        <Plus />
                        Insert form
                      </Button>
                    </div>
                  </div>
                )}
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}
