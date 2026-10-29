"use client"

import type * as React from "react"
import {
  ChevronRight,
  FileText,
  MoreHorizontal,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CollectionRow } from "@/components/tracer/collection-table"
import { collectionTable } from "@/components/tracer/collection-table-styles"
import { BuildStatus } from "../shared/build-layout"
import {
  knowledgeSourceStatusLabel,
  knowledgeSourceStatusMessage,
  type KnowledgeSource,
} from "@/src/lib/build/knowledge"

export function KnowledgeSourceRow({
  source,
  icon: Icon,
  kindLabel,
  onOpen,
  onReindex,
  onDelete,
  ...rowProps
}: {
  source: KnowledgeSource
  icon: LucideIcon
  kindLabel: string
  onOpen: () => void
  onReindex: () => void
  onDelete: () => void
} & React.ComponentProps<typeof CollectionRow>) {
  const indexedPages = source.statusMessage?.match(
    /^(\d+) pages indexed\./
  )?.[1]
  const detail =
    source.uri?.replace(/^https?:\/\//, "").replace(/\/$/, "") ||
    source.fileName ||
    kindLabel
  const statusMessage = knowledgeSourceStatusMessage(source)?.replace(
    /^\d+ pages indexed\.\s*/,
    ""
  )
  const indexedAt = source.lastIndexedAt ? new Date(source.lastIndexedAt) : null
  const hasIndexedAt = indexedAt && Number.isFinite(indexedAt.getTime())
  return (
    <CollectionRow {...rowProps} rowLabel={`Open ${source.name}`} onClick={onOpen}>
      <td aria-hidden className="p-0" />
      <td className={`${collectionTable.cell} rounded-l-md py-3`}>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-foreground-muted">
            <Icon aria-hidden className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto max-w-full justify-start p-0 text-sm"
              onClick={(event) => {
                event.stopPropagation()
                onOpen()
              }}
            >
              <span className="truncate">{source.name}</span>
            </Button>
            <p
              className="mt-1 truncate text-xs text-foreground-muted"
              title={source.uri ?? source.fileName ?? undefined}
            >
              {detail}
            </p>
            {statusMessage ? (
              <p
                className={`mt-1 truncate text-xs ${source.status === "error" ? "text-destructive" : "text-foreground-muted"}`}
                title={statusMessage}
              >
                {statusMessage}
              </p>
            ) : null}
          </div>
        </div>
      </td>
      <td className={collectionTable.cell}>
        {indexedPages ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-foreground-muted">
            <FileText aria-hidden className="size-3.5" />
            <span className="tabular-nums">
              {Number(indexedPages).toLocaleString()} pages
            </span>
          </span>
        ) : (
          <span className="text-xs text-foreground-muted">{kindLabel}</span>
        )}
      </td>
      <td className={collectionTable.cell}>
        <BuildStatus
          state={source.status}
          label={knowledgeSourceStatusLabel(source)}
        />
      </td>
      <td className={collectionTable.cell}>
        <p className="text-xs text-foreground-muted">
          {hasIndexedAt
            ? new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
              }).format(indexedAt)
            : "Not indexed yet"}
        </p>
        <p className="mt-1 text-xs text-foreground-muted">
          {hasIndexedAt
            ? `${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(indexedAt)} · `
            : ""}
          Revision {source.revision}
        </p>
      </td>
      <td
        className={collectionTable.cell}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-end gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="ghost-muted"
                size="icon-sm"
                aria-label={`Actions for ${source.name}`}
              >
                <MoreHorizontal className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={onReindex}>
                <RefreshCw className="size-3.5" />
                Reindex source
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={onDelete} variant="destructive">
                <Trash2 className="size-3.5" />
                Delete source
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            type="button"
            variant="ghost-muted"
            size="icon-sm"
            aria-label={`Open ${source.name}`}
            onClick={onOpen}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </td>
    </CollectionRow>
  )
}
