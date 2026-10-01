# Dataset folders

The datasets collection uses the shared `CollectionTable`. Each expanded folder and
the root end with a **+ Add** row. Clicking Add replaces that button with a
focused inline input. Press Enter to create or Escape to cancel. A trailing
slash (`Foo/Bar/`) creates a folder; otherwise the final segment is a dataset
(`Foo/Bar/Core` creates a `Core` dataset). Missing folders are created
automatically. Paths entered inside a folder are relative to that folder.
Empty folders persist after their last dataset moves elsewhere.

Each nesting level adds 32px of indentation. Vertical guides mark ancestor
levels through datasets, nested folders, status rows and the final Add row.
The compact selection gutter is 32px wide. The Name header, root labels, Add
labels and input caret share a text position; child rows use that same layout
at each depth. Folder and dataset icons use distinct shapes and semantic
resource colors defined in the central stylesheet.

Checkboxes stay visible on every saved folder and dataset. Selecting a folder
selects its row. The header checkbox selects the currently visible, loaded
entries, including expanded folders' children, and shows partial selection.
Row selections survive collapse/reopen and moves by ID. Entries with temporary
IDs become selectable when saved. Column header selection,
menus and the Display control are disabled for this tree.

Creation and moves update the table immediately while the request saves in
the background. Enter clears the input and keeps it focused for the next
entry. New paths expand immediately, and opening any folder uses the loaded
tree. Only entries involved in an unfinished write are locked against
conflicting moves. A failed write removes its optimistic change, preserves
other changes and drafts, and offers Retry or Dismiss.

`DatasetLibraryCache` loads the entire project's folder and dataset metadata
through `scope=tree`, automatically fetching batches of up to 200 rows. Tree
pagination uses immutable IDs so renames and moves cannot shift the cursor's
sort position. The complete result is installed together; opening folders,
searching and browsing move destinations require no further requests. Dataset
item contents are loaded separately by the detail page; item counts remain in
the tree metadata.

The cache belongs to the project layout and survives navigation between its
pages. Returning to datasets or clicking Refresh revalidates it in the
background while retaining visible rows. Requests stay bound to the original
project even if navigation changes while a batch is loading. Create responses
include saved ancestor folders so temporary IDs can be replaced without
another read. Read revisions protect recent writes from stale responses;
failed or incomplete refreshes preserve the last complete tree and offer Retry.

Drag a dataset or folder's icon and name onto another folder, its Add row, or
the root Add row. Clicking still opens the dataset or toggles the folder.
A folder move includes its entire subtree. Right-click or long-press the name
and choose Move to, or press Shift+F10 on the focused name, to open the folder
picker. Self/descendant moves and occupied
destinations are rejected without changing the hierarchy. Search covers full
paths and dataset descriptions locally and returns a flat list of matches.
Opening a matching folder clears search and reveals its path in the tree.
The API still supports bounded child pages and server-side search for other
consumers.

Dataset names remain full resource paths. Moves change those paths while
preserving dataset IDs, items, evaluation references and detail URLs. Resource
push/pull clients should use the new path after a move. Dataset creation,
renaming, resource imports and folder moves share a project-scoped transaction
lock. Interactive reads use the existing read budget and snapshot machinery.

Apply `migrations/0005_dataset_folders.sql` through `bun run db:migrate` before
running the updated app. It adds the folder table and child-list indexes, then
creates parent folders for existing slash-separated dataset names. It does not
rename existing datasets.

Validation: run `tests/dataset-library.test.ts` against a disposable loopback
PostgreSQL database via `DATOOL_TEST_DATABASE_URL`, plus the connected-eval,
backend, project-isolation and shared collection/table tests. UI checks should
cover creation, nested Add ordering, dataset/folder/root drag moves, keyboard
moves, persistence, search, loading, failure/retry, focus and narrow viewports.
`tests/dataset-library-cache.test.ts` uses deferred requests to cover immediate
updates, concurrent saves, rollback, stale batched reads, local folder/search
access, cache reuse and isolation, incomplete refresh recovery, and retry after
the destination folder moves.
