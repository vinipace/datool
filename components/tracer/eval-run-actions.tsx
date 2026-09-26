"use client"

import { useWorkspaceHref } from "./workspace-path"
import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { PanelActionLabel } from "@/components/ui/panel-action-label"
import type { EvalRunDetail } from "@/src/lib/tracer/contracts"
import { tracerApi } from "./api"
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ProjectModelField } from "./project-model-field"
import type {
  FrozenPromptConfig,
  PromptOverrides,
} from "@/src/lib/tracer/prompt-overrides"
import { inputOverridesSchema } from "@/src/lib/tracer/eval-input-overrides"
import { RefreshCw, Play } from "lucide-react"
export function EvalRunActions({
  run,
  onChanged,
}: {
  run: EvalRunDetail
  onChanged?: () => void
}) {
  const workspaceHref = useWorkspaceHref()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [mode, setMode] = useState<"app" | "score" | null>(null)
  const [versions, setVersions] = useState("latest")
  const recorded = versions === "recorded"
  const [prompt, setPrompt] = useState("")
  const [overrides, setOverrides] = useState<PromptOverrides>({})
  const [inputs, setInputs] = useState("")
  const prompts =
    (run.metadata.promptConfig as FrozenPromptConfig | undefined)?.prompts ?? {}
  const app = run.metadata.app ?? run.metadata.sourceApp
  const appId =
    app &&
    typeof app === "object" &&
    !Array.isArray(app) &&
    typeof app.id === "string"
      ? app.id
      : null
  async function start(execute: boolean) {
    setBusy(true)
    setError("")
    try {
      const next = await tracerApi.evals.create({
        background: true,
        name: `${run.name ?? "Eval"} · ${execute ? "rerun" : "rescore"}`,
        useRecordedVersions: recorded,
        ...(versions === "judges"
          ? { evaluatorVersionIds: run.evaluatorVersionIds }
          : {}),
        ...(execute
          ? {
              parentRunId: run.id,
              ...(Object.keys(overrides).length
                ? { promptOverrides: overrides }
                : {}),
              ...(inputs.trim()
                ? {
                    inputOverrides: inputOverridesSchema.parse(
                      JSON.parse(inputs)
                    ),
                  }
                : {}),
            }
          : { sourceRunId: run.id }),
      })
      setMode(null)
      router.push(workspaceHref(`/evals/${next.id}?compare=${run.id}`))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  async function control(operation: string) {
    setBusy(true)
    setError("")
    try {
      await tracerApi.operation(operation, { id: run.id })
      onChanged?.()
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="relative text-sm">
      <div className="flex flex-wrap gap-2">
        {run.status !== "completed" && run.status !== "cancelled" && (
          <Button
            size="sm"
            variant="outline"
            disabled={
              busy ||
              (run.status === "running" &&
                run.execution?.workerOnline !== false)
            }
            onClick={() => void control("recover_eval_run")}
          >
            Recover unfinished
          </Button>
        )}
        {run.status === "running" && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() => void control("cancel_eval_run")}
          >
            Cancel run
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          aria-label="Re-score saved traces"
          title="Re-score saved traces"
          disabled={
            busy || run.status === "running" || run.evaluatorIds.length === 0
          }
          onClick={() => {
            setError("")
            if (versions === "judges") setVersions("recorded")
            setMode("score")
          }}
        >
          <RefreshCw aria-hidden className="size-3.5" />
          <PanelActionLabel className="sr-only lg:not-sr-only">
            Re-score
          </PanelActionLabel>
        </Button>
        {appId && (
          <Button
            size="sm"
            variant="outline"
            aria-label="Run app again"
            title="Run the app with the same cases and references, changing settings if needed"
            disabled={busy || run.status === "running"}
            onClick={() => {
              setError("")
              setMode("app")
            }}
          >
            <Play aria-hidden className="size-3.5" />
            <PanelActionLabel className="sr-only lg:not-sr-only">
              Run app again
            </PanelActionLabel>
          </Button>
        )}
      </div>
      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open) setMode(null)
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-auto">
          <DialogTitle>
            {mode === "app" ? "Run app again" : "Re-score saved outputs"}
          </DialogTitle>
          <DialogDescription>
            {mode === "app"
              ? "Reuse this run's frozen cases and references. The application executes again."
              : "Keep the saved app outputs and references. Only the judges execute."}
          </DialogDescription>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault()
              void start(mode === "app")
            }}
          >
            <label className="grid gap-1 text-sm">
              Versions
              <Select
                value={versions}
                onChange={(event) => setVersions(event.target.value)}
                disabled={busy}
              >
                <option value="latest">
                  Latest {mode === "app" ? "prompts and " : ""}scorers
                </option>
                {mode === "app" && (
                  <option
                    value="judges"
                    disabled={
                      !Object.keys(run.evaluatorVersionIds ?? {}).length
                    }
                  >
                    Latest prompts, recorded scorers
                  </option>
                )}
                <option value="recorded">
                  Use recorded {mode === "app" ? "prompt and " : ""}scorer
                  versions
                </option>
              </Select>
            </label>
            <p className="text-xs text-foreground-muted">
              Resolved versions are recorded automatically. Hold the judges
              constant when measuring application changes.
            </p>
            {mode === "app" && (
              <>
                {Object.keys(prompts).length ? (
                  <label className="grid gap-1 text-sm">
                    Change prompt settings
                    <Select
                      value={prompt}
                      onChange={(event) => {
                        setPrompt(event.target.value)
                        setOverrides({})
                      }}
                      disabled={busy}
                    >
                      <option value="">Keep settings</option>
                      {Object.keys(prompts).map((slug) => (
                        <option key={slug} value={slug}>
                          {slug}
                        </option>
                      ))}
                    </Select>
                  </label>
                ) : (
                  <p className="text-sm text-foreground-muted">
                    No managed prompts were recorded in this run.
                  </p>
                )}
                {prompt && (
                  <>
                    <label className="grid gap-1 text-sm">
                      Prompt version
                      <Input
                        type="number"
                        min={1}
                        placeholder={
                          recorded
                            ? `Recorded v${prompts[prompt]?.version}`
                            : "Latest published"
                        }
                        value={overrides[prompt]?.version ?? ""}
                        onChange={(event) =>
                          setOverrides((previous) => ({
                            ...previous,
                            [prompt]: {
                              ...previous[prompt],
                              version: event.target.value
                                ? Number(event.target.value)
                                : undefined,
                            },
                          }))
                        }
                      />
                    </label>
                    <ProjectModelField
                      model={overrides[prompt]?.model ?? ""}
                      disabled={busy}
                      onChange={(selection) =>
                        setOverrides((previous) => ({
                          ...previous,
                          [prompt]: {
                            ...previous[prompt],
                            model: selection.model || undefined,
                          },
                        }))
                      }
                    />
                  </>
                )}
                <details>
                  <summary className="cursor-pointer text-sm">
                    Input overrides
                  </summary>
                  <label className="mt-2 grid gap-1 text-sm">
                    Changes to app input (JSON object)
                    <Textarea
                      value={inputs}
                      onChange={(event) => setInputs(event.target.value)}
                      placeholder="{}"
                      rows={3}
                    />
                  </label>
                </details>
              </>
            )}
            {error && (
              <Notice variant="error" role="alert">
                {error}
              </Notice>
            )}
            <Button type="submit" disabled={busy} loading={busy}>
              {mode === "app" ? "Run app" : "Re-score outputs"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
      {!mode && error && (
        <Notice
          role="alert"
          variant="error"
          className="absolute top-full right-0 z-10 mt-2 w-64 bg-background"
        >
          {error}
        </Notice>
      )}
    </div>
  )
}
