"use client"
import { useState } from "react"
import type { z } from "zod"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/ui/notice"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet"
import { useRemote } from "@/components/tracer/hooks"
import { useProjectScope } from "@/components/tracer/project-scope-context"
import {
  buildCall,
  formatBuildError,
} from "@/components/build/shared/build-api"
import type { AgentDrive } from "@/src/lib/build/sandbox"
import type { driveVersionSchema } from "@/src/lib/build/storage"

type Version = z.infer<typeof driveVersionSchema>
export function DriveVersions({
  drive,
  onClose,
}: {
  drive: AgentDrive
  onClose: () => void
}) {
  const scope = useProjectScope()
  const state = useRemote(
    (signal) =>
      buildCall<{ items: Version[] }>(
        "build_list_drive_versions",
        { driveId: drive.id },
        { signal }
      ),
    [drive.id]
  )
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [restoring, setRestoring] = useState<Version | null>(null)
  const [archive, setArchive] = useState<File | null>(null)
  const current =
    state.data?.items.find((version) => version.current)?.id ??
    drive.revision ??
    null
  const path = scope
    ? `/api/projects/${encodeURIComponent(scope.projectId)}/drives/${drive.id}/archive`
    : null
  async function action(execute: () => Promise<unknown>) {
    setPending(true)
    setError(null)
    try {
      await execute()
      setRestoring(null)
      setArchive(null)
      state.refresh()
    } catch (reason) {
      setError(formatBuildError(reason))
    } finally {
      setPending(false)
    }
  }
  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose()
      }}
    >
      <SheetContent
        showCloseButton={!pending}
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault()
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault()
        }}
      >
        <SheetHeader className="shrink-0 border-b border-border px-6 py-5 pr-12">
          <SheetTitle>{drive.name}: saved versions</SheetTitle>
          <SheetDescription>
            Versions contain committed files. Restoring creates a new version
            and keeps the previous history.
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto p-6">
          {(error || state.error) && (
            <Notice variant="error" role="alert">
              {error ?? state.error?.message}
              <Button size="sm" variant="link" onClick={state.refresh}>
                Refresh versions
              </Button>
            </Notice>
          )}
          {state.isLoading && <p role="status">Loading versions…</p>}
          {drive.syncPending && (
            <Notice>
              Files may still be syncing. If the sandbox has expired, recover
              its files before editing this drive.
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() =>
                  void action(() =>
                    buildCall("build_recover_drive", { driveId: drive.id })
                  )
                }
              >
                Recover pending files
              </Button>
            </Notice>
          )}
          {path && (
            <Button asChild variant="outline" size="sm">
              <a href={path} download>
                Export committed files (.tar)
              </a>
            </Button>
          )}
          {!state.isLoading && !state.data?.items.length && !state.error && (
            <p className="text-sm text-foreground-muted">
              No saved versions yet. Files are saved after SDK edits and sandbox
              runs.
            </p>
          )}
          <ul className="divide-y divide-border">
            {state.data?.items.map((version) => (
              <li
                key={version.id}
                className="flex items-center justify-between gap-3 py-3 text-sm"
              >
                <div>
                  <p>
                    {new Date(version.createdAt).toLocaleString()}
                    {version.current ? " · Current" : ""}
                  </p>
                  <p className="text-xs text-foreground-muted">
                    {version.files} files · {Math.ceil(version.bytes / 1024)}{" "}
                    KiB
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || version.current}
                  onClick={() => {
                    setRestoring(version)
                    setArchive(null)
                  }}
                >
                  Restore
                </Button>
              </li>
            ))}
          </ul>
          {path && (
            <div className="space-y-2">
              <label htmlFor="drive-import" className="text-sm">
                Import a tar backup
              </label>
              <Input
                id="drive-import"
                type="file"
                accept=".tar,application/x-tar"
                disabled={pending || state.isLoading || Boolean(state.error)}
                onChange={(event) => {
                  setArchive(event.target.files?.[0] ?? null)
                  setRestoring(null)
                }}
              />
              <p className="text-xs text-foreground-muted">
                Regular files and directories only. 16 MiB per file, 64 MiB
                total; archive at most 80 MiB.
              </p>
            </div>
          )}
          {(restoring || archive) && (
            <Notice>
              This replaces the current files. Previous committed versions
              remain available.
              <div className="mt-3 flex gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => {
                    setRestoring(null)
                    setArchive(null)
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  loading={pending}
                  onClick={() =>
                    void action(async () => {
                      if (restoring)
                        return buildCall("build_restore_drive_version", {
                          driveId: drive.id,
                          versionId: restoring.id,
                          expectedRevision: current,
                        })
                      if (!archive || !path) return
                      if (archive.size > 80 * 1024 * 1024)
                        throw new Error("The archive exceeds 80 MiB.")
                      const response = await fetch(path, {
                        method: "PUT",
                        headers: {
                          "Content-Type": "application/x-tar",
                          "If-Match": current ?? "empty",
                        },
                        body: archive,
                      })
                      if (!response.ok) {
                        const body = await response.json()
                        throw new Error(body.error?.message ?? "Import failed.")
                      }
                    })
                  }
                >
                  {archive ? "Import backup" : "Restore version"}
                </Button>
              </div>
            </Notice>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
