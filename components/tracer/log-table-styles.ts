export const logTable = {
  table: "w-full table-fixed border-separate border-spacing-x-0 border-spacing-y-0.5 text-left text-sm",
  head: "bg-surface-canvas text-sm font-normal text-foreground-muted",
  heading: "h-12 border-r border-border px-3 py-1.5 align-middle font-normal last:border-r-0",
  row: "group log-table-row h-10 cursor-pointer bg-surface-row transition-colors outline-none hover:bg-surface-row-hover focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
  runningRow: "bg-warning/10 hover:bg-warning/15",
  cell: "h-10 px-3 py-0 align-middle first:rounded-l-md last:rounded-r-md",
  compactRow: "[&>td]:h-10! [&>td]:py-0! [&>td]:align-middle!",
  compactCellContent: "max-h-6 overflow-hidden text-ellipsis whitespace-nowrap [&_*]:whitespace-nowrap [&_p]:m-0 [&_br]:hidden has-[button]:max-h-8 has-[input]:max-h-8 has-[[data-slot=user-avatar]]:max-h-8 has-[[data-slot=percentage-cell]]:max-h-8",
  compactContent: "max-h-6 overflow-hidden text-ellipsis whitespace-nowrap [&_*]:whitespace-nowrap [&_p]:m-0",
  tallContent: "whitespace-pre-wrap [overflow-wrap:anywhere]",
}
