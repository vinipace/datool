"use client"

import * as React from "react"
import { Button } from "@/components/ui/button"
import { CodeEditor } from "@/components/ui/code-editor"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import type { CreateDatasetItemInput } from "@/src/lib/tracer/contracts"

export function DatasetImportDialog({
  onClose,
  onImport,
}: {
  onClose: () => void
  onImport: (items: CreateDatasetItemInput[]) => Promise<void>
}) {
  const [text, setText] = React.useState(
    '[\n  { "input": {}, "expectedOutput": null, "metadata": {} }\n]'
  )
  const [error, setError] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  async function save() {
    setError("")
    try {
      const items: unknown = JSON.parse(text)
      if (
        !Array.isArray(items) ||
        !items.length ||
        items.length > 100 ||
        items.some(
          (item) => !item || typeof item !== "object" || !("input" in item)
        )
      )
        throw new Error(
          "Supply an array of 1–100 rows, each with an input field."
        )
      setBusy(true)
      await onImport(items as CreateDatasetItemInput[])
      onClose()
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <DialogContent className="max-w-3xl bg-background">
        <DialogHeader>
          <DialogTitle>Import dataset rows</DialogTitle>
          <DialogDescription>
            Paste JSON or choose a file. Up to 100 rows are imported together;
            if a row fails validation, nothing is added.
          </DialogDescription>
        </DialogHeader>
        <Input
          aria-label="Import JSON file"
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (!file) return
            if (file.size > 4 * 1024 * 1024) {
              setError("Choose a file smaller than 4 MiB.")
              return
            }
            void file
              .text()
              .then(setText)
              .catch(() => setError("Unable to read the file."))
          }}
        />
        <CodeEditor
          value={text}
          onChange={setText}
          label="Import rows JSON"
          language="json"
          className="h-80"
        />
        {error && (
          <Notice variant="error" role="alert">
            {error}
          </Notice>
        )}
        <div className="flex justify-end">
          <Button loading={busy} onClick={() => void save()}>
            Import rows
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
