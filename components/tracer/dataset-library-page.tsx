"use client"

import * as React from "react"
import Link from "next/link"
import { ChevronRight, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Input } from "@/components/ui/input"
import { Notice } from "@/components/ui/notice"
import {
  TreeAddButton,
  TreeIndent,
  treeTable,
} from "@/components/ui/tree-table"
import {
  datasetLeafName,
  type DatasetLibraryEntry,
} from "@/src/lib/tracer/dataset-library"
import { tracerApi } from "./api"
import { DatasetKindIcon } from "./dataset-kind-icon"
import {
  DatasetLibraryCache,
  getDatasetLibraryCache,
  type FolderTarget,
} from "@/src/lib/tracer/dataset-library-cache"
import { CollectionPanel } from "./collection-panel"
import { CollectionPage, CollectionSearch } from "./collection-page"
import { formatDate, formatRelative } from "./format"
import { CollectionRow, CollectionRowSelection, CollectionSelectAll, CollectionTable } from "./collection-table"
import { collectionTable } from "./collection-table-styles"
import { useWorkspaceHref, useWorkspaceStorageScope } from "./workspace-path"
import { useProjectScope } from "./project-scope-context"

const root: FolderTarget = { id: null, name: "" }
const dragType = "application/x-datool-dataset-entry"
type LibraryContextValue = {
  expanded: Set<string>
  toggle: (name: string, reveal?: boolean) => void
  checkedIds: Set<string>
  toggleSelection: (id: string) => void
  adding: FolderTarget | null
  add: (target: FolderTarget | null) => void
  create: (value: string, target: FolderTarget) => void
  chooseMove: (entry: DatasetLibraryEntry) => void
  dragged: DatasetLibraryEntry | null
  setDragged: (entry: DatasetLibraryEntry | null) => void
  dropTarget: string | null
  setDropTarget: (id: string | null) => void
  move: (entry: DatasetLibraryEntry, target: FolderTarget) => boolean
  cache: DatasetLibraryCache
}
const LibraryContext = React.createContext<LibraryContextValue>(null!)

function useDropTarget(target: FolderTarget) {
  const library = React.useContext(LibraryContext)
  const key = target.id ?? "root"
  const allowed =
    !!library.dragged && library.cache.canMove(library.dragged, target)
  return {
    "data-drop-target": (library.dropTarget === key && allowed) || undefined,
    onDragOver: (event: React.DragEvent) => {
      if (!allowed) return
      event.preventDefault()
      event.stopPropagation()
      event.dataTransfer.dropEffect = "move"
      library.setDropTarget(key)
    },
    onDragLeave: (event: React.DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        library.setDropTarget(null)
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault()
      event.stopPropagation()
      if (allowed && library.dragged) void library.move(library.dragged, target)
      library.setDragged(null)
      library.setDropTarget(null)
    },
  }
}

function AddRow({ target, depth }: { target: FolderTarget; depth: number }) {
  const library = React.useContext(LibraryContext)
  const drop = useDropTarget(target)
  return (
    <CollectionRow
      className={treeTable.row}
      {...drop}
      aria-label={`Add row in ${target.name || "root"}`}
    >
      <td className={collectionTable.cell} />
      <td className={`${collectionTable.cell} ${treeTable.nameCell}`}>
        <TreeIndent depth={depth}>
          {library.adding?.name === target.name ? (
            <InlineAddInput target={target} />
          ) : (
            <TreeAddButton
              label={`Add in ${target.name || "root"}`}
              onClick={() => library.add(target)}
            />
          )}
        </TreeIndent>
      </td>
      <td className={collectionTable.cell} />
      <td className={collectionTable.cell} />
      <td className={collectionTable.cell} />
    </CollectionRow>
  )
}

function InlineAddInput({ target }: { target: FolderTarget }) {
  const library = React.useContext(LibraryContext)
  const [value, setValue] = React.useState("")
  const [error, setError] = React.useState<Error | null>(null)
  const errorId = React.useId()
  return (
    <form
      className={treeTable.inputContainer}
      onSubmit={(event) => {
        event.preventDefault()
        if (!value.trim()) return
        try {
          library.create(value, target)
          setValue("")
          setError(null)
        } catch (error) {
          setError(
            error instanceof Error
              ? error
              : new Error("Could not add this entry.")
          )
        }
      }}
    >
      <Input
        autoFocus
        required
        maxLength={201}
        className={treeTable.input}
        aria-label={`Name or path in ${target.name || "root"}`}
        placeholder="Dataset or folder/"
        value={value}
        invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => {
          if (!value.trim()) library.add(null)
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault()
            event.stopPropagation()
            library.add(null)
          }
        }}
      />
      {error && (
        <Notice id={errorId} role="alert" variant="error">
          {error.message}
        </Notice>
      )}
    </form>
  )
}

function LibraryRow({
  entry,
  depth,
  search = false,
}: {
  entry: DatasetLibraryEntry
  depth: number
  search?: boolean
}) {
  const library = React.useContext(LibraryContext)
  const href = useWorkspaceHref()
  const expanded = !search && library.expanded.has(entry.name)
  const pending = library.cache.isPending(entry)
  const target = { id: entry.id, name: entry.name }
  const drop = useDropTarget(target)
  const label = search ? entry.name : datasetLeafName(entry.name)
  const didDrag = React.useRef(false)
  const dragProps: React.HTMLAttributes<HTMLElement> = {
    draggable: !pending,
    title: "Drag to move, or right-click for options",
    "aria-keyshortcuts": pending ? undefined : "Shift+F10",
    onPointerDown: () => {
      didDrag.current = false
    },
    onClickCapture: (event) => {
      if (!didDrag.current) return
      event.preventDefault()
      event.stopPropagation()
      didDrag.current = false
    },
    onKeyDown: (event) => {
      didDrag.current = false
      if (
        !pending &&
        (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
      ) {
        event.preventDefault()
        library.chooseMove(entry)
      }
    },
    onDragStart: (event) => {
      if (pending) {
        event.preventDefault()
        return
      }
      didDrag.current = true
      event.dataTransfer.setData(dragType, entry.id)
      event.dataTransfer.effectAllowed = "move"
      library.setDragged(entry)
    },
    onDragEnd: () => {
      library.setDragged(null)
      library.setDropTarget(null)
    },
  }
  return (
    <>
      <CollectionRow
        className={treeTable.row}
        checked={library.checkedIds.has(entry.id)}
        data-entry-id={entry.id}
        data-entry-name={entry.name}
        data-kind={entry.kind}
        data-dragging={library.dragged?.id === entry.id || undefined}
        {...(entry.kind === "folder" ? drop : {})}
      >
        <CollectionRowSelection
          className={treeTable.selectionCell}
          checked={library.checkedIds.has(entry.id)}
          disabled={entry.id.startsWith("pending:")}
          label={`Select ${entry.kind} ${entry.name}`}
          onChange={() => library.toggleSelection(entry.id)}
        />
        <td className={`${collectionTable.cell} ${treeTable.nameCell}`}>
          <TreeIndent depth={depth}>
            <ContextMenu>
              <ContextMenuTrigger asChild disabled={pending}>
                {entry.kind === "folder" ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={treeTable.label}
                    {...dragProps}
                    aria-expanded={search ? undefined : expanded}
                    aria-label={`${search ? "Open" : expanded ? "Collapse" : "Expand"} ${entry.name}`}
                    onClick={() => library.toggle(entry.name, search)}
                  >
                    <ChevronRight
                      className={`-ml-4 size-4 shrink-0 ${expanded ? "rotate-90" : ""}`}
                    />
                    <DatasetKindIcon kind="folder" expanded={expanded} />
                    <span className="truncate">{label}</span>
                  </Button>
                ) : entry.id.startsWith("pending:") ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    className={treeTable.label}
                    disabled
                    aria-label={`${label}, saving`}
                  >
                    <span aria-hidden="true" />
                    <DatasetKindIcon kind="dataset" />
                    <span className="truncate">{label}</span>
                  </Button>
                ) : (
                  <Button
                    asChild
                    variant="ghost"
                    size="sm"
                    className={treeTable.label}
                  >
                    <Link
                      {...dragProps}
                      href={href(`/datasets/${encodeURIComponent(entry.id)}`)}
                    >
                      <span aria-hidden="true" />
                      <DatasetKindIcon kind="dataset" />
                      <span className="truncate">{label}</span>
                    </Link>
                  </Button>
                )}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => library.chooseMove(entry)}>
                  Move to…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          </TreeIndent>
        </td>
        <td className={`${collectionTable.cell} text-foreground-muted tabular-nums`}>
          {entry.kind === "folder" ? "Folder" : `${entry.itemCount ?? 0} items`}
        </td>
        <td className={`${collectionTable.cell} text-foreground-muted`}>
          <div className="truncate">{entry.description || "—"}</div>
        </td>
        <td
          className={`${collectionTable.cell} text-foreground-muted`}
          title={formatDate(entry.updatedAt)}
        >
          {pending ? (
            <span role="status">Saving…</span>
          ) : (
            formatRelative(entry.updatedAt)
          )}
        </td>
      </CollectionRow>
      {entry.kind === "folder" && expanded && !search && (
        <FolderRows target={target} depth={depth + 1} />
      )}
    </>
  )
}

type LibraryPageState = ReturnType<DatasetLibraryCache["page"]>

function BranchRows({
  page,
  target,
  depth,
  search = false,
}: {
  page: LibraryPageState
  target: FolderTarget
  depth: number
  search?: boolean
}) {
  return (
    <>
      {page.items.map((entry) => (
        <LibraryRow
          key={`${entry.kind}:${entry.name}`}
          entry={entry}
          depth={depth}
          search={search}
        />
      ))}
      {search && !page.isLoading && !page.items.length && (
        <StatusRow depth={depth}>No matching folders or datasets.</StatusRow>
      )}
      <AddRow target={target} depth={depth} />
    </>
  )
}

function StatusRow({
  depth,
  children,
}: React.PropsWithChildren<{ depth: number }>) {
  return (
    <CollectionRow className="cursor-default">
      <td className={collectionTable.cell} />
      <td
        className={`${collectionTable.cell} ${treeTable.nameCell} text-foreground-muted`}
      >
        <TreeIndent depth={depth}>{children}</TreeIndent>
      </td>
      <td />
      <td />
      <td />
    </CollectionRow>
  )
}

function FolderRows({
  target,
  depth,
}: {
  target: FolderTarget
  depth: number
}) {
  const { cache } = React.useContext(LibraryContext)
  const page = cache.page(target)
  return <BranchRows page={page} target={target} depth={depth} />
}

export function DatasetsPage() {
  const scope = useWorkspaceStorageScope()
  return (
    <CollectionPanel label="Datasets">
      <DatasetLibraryView key={scope} />
    </CollectionPanel>
  )
}

function DatasetLibraryView() {
  const projectScope = useProjectScope()
  const [query, setQuery] = React.useState("")
  const [cache] = React.useState(() => {
    const projectId = projectScope?.projectId
    const api = {
      library: (options: { cursor?: string; limit: number }) =>
        tracerApi.datasets.library({ ...options, scope: "tree", projectId }),
      addEntry: (input: Parameters<typeof tracerApi.datasets.addEntry>[0]) =>
        tracerApi.datasets.addEntry(input, projectId),
      moveEntry: (input: Parameters<typeof tracerApi.datasets.moveEntry>[0]) =>
        tracerApi.datasets.moveEntry(input, projectId),
    }
    return projectScope
      ? getDatasetLibraryCache(projectScope, api)
      : new DatasetLibraryCache(api)
  })
  React.useEffect(() => {
    void cache.refresh()
  }, [cache])
  React.useSyncExternalStore(
    cache.subscribe,
    cache.getSnapshot,
    cache.getSnapshot
  )
  const filter = query.trim()
  const page = cache.page(root, filter)
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set())
  const [checkedIds, setCheckedIds] = React.useState<Set<string>>(new Set())
  const [adding, setAdding] = React.useState<FolderTarget | null>(null)
  const [moving, setMoving] = React.useState<DatasetLibraryEntry | null>(null)
  const [dragged, setDragged] = React.useState<DatasetLibraryEntry | null>(null)
  const [dropTarget, setDropTarget] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState("")
  const [moveError, setMoveError] = React.useState<Error | null>(null)
  // Match rendered branches, including loaded children of expanded folders.
  const visibleEntries = new Map<string, DatasetLibraryEntry>()
  function collectVisible(entries: DatasetLibraryEntry[]) {
    for (const entry of entries) {
      if (visibleEntries.has(entry.id)) continue
      visibleEntries.set(entry.id, entry)
      if (!filter && entry.kind === "folder" && expanded.has(entry.name)) {
        collectVisible(cache.page(entry).items)
      }
    }
  }
  collectVisible(page.items)
  const selectableEntries = [...visibleEntries.values()].filter(
    (entry) => !entry.id.startsWith("pending:")
  )
  const checkedEntries = selectableEntries.filter((entry) =>
    checkedIds.has(entry.id)
  )
  const checkedCount = checkedEntries.length
  const allChecked =
    selectableEntries.length > 0 && checkedCount === selectableEntries.length
  const move = (entry: DatasetLibraryEntry, target: FolderTarget) => {
    try {
      if (!cache.move(entry, target)) return false
      const nextName = target.name
        ? `${target.name}/${datasetLeafName(entry.name)}`
        : datasetLeafName(entry.name)
      setExpanded(
        (current) =>
          new Set([
            ...current,
            ...[...current].map((path) =>
              path === entry.name || path.startsWith(`${entry.name}/`)
                ? nextName + path.slice(entry.name.length)
                : path
            ),
            ...(target.name ? [target.name] : []),
          ])
      )
      setMoveError(null)
      setAnnouncement(
        `Moved ${datasetLeafName(entry.name)} to ${target.name || "root"}.`
      )
      return true
    } catch (error) {
      setMoveError(
        error instanceof Error ? error : new Error("Could not move this entry.")
      )
      return false
    }
  }
  return (
    <LibraryContext.Provider
      value={{
        expanded,
        checkedIds,
        toggleSelection: (id) =>
          setCheckedIds((current) => {
            const next = new Set(current)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
          }),
        toggle: (name, reveal) => {
          if (reveal) setQuery("")
          setExpanded((current) => {
            const next = new Set(current)
            if (reveal) {
              const parts = name.split("/")
              parts.forEach((_, index) =>
                next.add(parts.slice(0, index + 1).join("/"))
              )
            } else if (next.has(name)) next.delete(name)
            else next.add(name)
            return next
          })
        },
        adding,
        add: setAdding,
        create: (value, target) => {
          const entries = cache.create(value, target)
          setExpanded(
            (current) =>
              new Set([
                ...current,
                ...entries
                  .filter((entry) => entry.kind === "folder")
                  .map((entry) => entry.name),
              ])
          )
          setAnnouncement(`Added ${entries.at(-1)!.name}.`)
        },
        chooseMove: (entry) => {
          setMoveError(null)
          setMoving(entry)
        },
        dragged,
        setDragged,
        dropTarget,
        setDropTarget,
        move,
        cache,
      }}
    >
      <CollectionPage
        className="contents"
        selection={{
          rows: checkedEntries,
          onClear: () => setCheckedIds(new Set()),
        }}
        state={{ ...page, refresh: () => cache.refresh() }}
        loadingLabel="Loading datasets"
        header={{
          exportRows: page.items,
          exportName: "datasets",
          menuActions: (
            <DropdownMenuItem onSelect={() => setAdding(root)}>
              <Plus className="size-3.5" />
              Add dataset or folder
            </DropdownMenuItem>
          ),
          children: (
            <CollectionSearch
              label="Search datasets and folders"
              value={query}
              onChange={setQuery}
            />
          ),
        }}
        toolbar={
          <>
            {moveError && !moving && (
              <Notice role="alert" variant="error">
                {moveError.message}
              </Notice>
            )}
            {cache.failures.map((failure) => (
              <Notice key={failure.id} role="alert" variant="error">
                {failure.message}
                <Button variant="ghost" size="sm" onClick={failure.retry}>
                  Retry
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => cache.dismiss(failure.id)}
                >
                  Dismiss
                </Button>
              </Notice>
            ))}
            <p role="status" className="sr-only">
              {announcement}
            </p>
          </>
        }
      >
        <CollectionTable
          fillHeight
          displayControls={false}
          enableCardView={false}
          enableRowHeight={false}
          reorderable={false}
          selectionColumnWidth={32}
          widths={[360, 110, 260, 150]}
          columnIds={["name", "items", "description", "updated"]}
        >
          <caption className="sr-only">
            Datasets and folders. Drag an icon and name to move. Right-click or
            press Shift+F10 on a name to choose a destination.
          </caption>
          <thead className={collectionTable.head}>
            <tr>
              <th className={treeTable.selectionCell} scope="col">
                <CollectionSelectAll
                  checked={allChecked}
                  partial={checkedCount > 0 && !allChecked}
                  disabled={!selectableEntries.length}
                  label="Select all visible datasets and folders"
                  onChange={() =>
                    setCheckedIds((current) => {
                      const next = new Set(current)
                      for (const entry of selectableEntries) {
                        if (allChecked) next.delete(entry.id)
                        else next.add(entry.id)
                      }
                      return next
                    })
                  }
                />
              </th>
              <th
                className={`${collectionTable.heading} ${treeTable.columnHeading} ${treeTable.heading}`}
                scope="col"
              >
                Name
              </th>
              <th className={`${collectionTable.heading} ${treeTable.columnHeading}`}>
                Items
              </th>
              <th className={`${collectionTable.heading} ${treeTable.columnHeading}`}>
                Description
              </th>
              <th className={`${collectionTable.heading} ${treeTable.columnHeading}`}>
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            <BranchRows page={page} target={root} depth={0} search={!!filter} />
          </tbody>
        </CollectionTable>
      </CollectionPage>
      {moving && (
        <MoveEntryDialog
          entry={moving}
          onClose={() => setMoving(null)}
          move={move}
          error={moveError}
        />
      )}
    </LibraryContext.Provider>
  )
}

function MoveEntryDialog({
  entry,
  onClose,
  move,
  error,
}: {
  entry: DatasetLibraryEntry
  onClose: () => void
  move: LibraryContextValue["move"]
  error: Error | null
}) {
  const [trail, setTrail] = React.useState<FolderTarget[]>([root])
  const target = trail.at(-1)!
  const { cache } = React.useContext(LibraryContext)
  const page = cache.page(target)
  const folders = page.items.filter(
    (item) =>
      item.kind === "folder" &&
      !(
        entry.kind === "folder" &&
        (item.name === entry.name || item.name.startsWith(`${entry.name}/`))
      )
  )
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move {datasetLeafName(entry.name)}</DialogTitle>
          <DialogDescription>
            Choose a destination folder. Moving a folder includes all its
            contents.
          </DialogDescription>
        </DialogHeader>
        <div
          className="flex flex-wrap items-center gap-1"
          aria-label="Destination path"
        >
          {trail.map((part, index) => (
            <Button
              key={part.id ?? "root"}
              variant="ghost"
              size="sm"
              onClick={() => setTrail((current) => current.slice(0, index + 1))}
            >
              {part.name ? datasetLeafName(part.name) : "Root"}
              {index < trail.length - 1 && <ChevronRight className="size-3" />}
            </Button>
          ))}
        </div>
        <div className="grid max-h-64 gap-1 overflow-y-auto rounded-md border border-border p-2">
          {page.isLoading && (
            <p role="status" className="p-2 text-sm text-foreground-muted">
              Loading folders…
            </p>
          )}
          {page.error && (
            <Notice role="alert" variant="error">
              {page.error.message}
              <Button variant="ghost" size="sm" onClick={page.refresh}>
                Retry
              </Button>
            </Notice>
          )}
          {!page.isLoading && !page.error && !folders.length && (
            <p className="p-2 text-sm text-foreground-muted">
              No folders on this page.
            </p>
          )}
          {folders.map((folder) => (
            <Button
              key={folder.id}
              variant="ghost"
              className="justify-start"
              onClick={() =>
                setTrail((current) => [
                  ...current,
                  { id: folder.id, name: folder.name },
                ])
              }
            >
              <DatasetKindIcon kind="folder" />
              <span className="truncate">{datasetLeafName(folder.name)}</span>
              <ChevronRight className="ml-auto size-4" />
            </Button>
          ))}
        </div>
        {error && (
          <Notice role="alert" variant="error">
            {error.message}
          </Notice>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!cache.canMove(entry, target) || !page.data}
            onClick={() => {
              if (move(entry, target)) onClose()
            }}
          >
            Move here
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
