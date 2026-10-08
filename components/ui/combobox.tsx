"use client"

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox"
import { Check, ChevronsUpDown, Search, X } from "lucide-react"
import { useOverlayContainer } from "./overlay-container"
import { cn } from "@/lib/utils"
import { buttonVariants } from "./button"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "./hover-card"

export type ComboboxOption = {
  value: string
  label: string
  group?: string
  keywords?: string[]
  description?: string
  descriptionBelow?: boolean
  /** Let explanatory text wrap below an option instead of truncating it. */
  descriptionWrap?: boolean
  disabled?: boolean
  badge?: ReactNode
  icon?: ComponentType<{ className?: string; "aria-hidden"?: true }>
  leading?: ReactNode
  labelAdornment?: ReactNode
  /** Additional details shown beside the option on hover. */
  preview?: ReactNode
  trailing?: ReactNode
}

function groupOptions(options: ComboboxOption[]) {
  const groups = new Map<string | undefined, ComboboxOption[]>()
  for (const option of options) {
    const items = groups.get(option.group) ?? []
    items.push(option)
    groups.set(option.group, items)
  }
  return Array.from(groups, ([label, items]) => ({ label, items }))
}

export function ComboboxGroup(props: ComboboxPrimitive.Group.Props) {
  return <ComboboxPrimitive.Group data-slot="combobox-group" {...props} />
}

export function ComboboxLabel({
  className,
  ...props
}: ComboboxPrimitive.GroupLabel.Props) {
  return (
    <ComboboxPrimitive.GroupLabel
      data-slot="combobox-label"
      className={cn(
        "px-2 py-1.5 text-xs font-medium text-foreground-muted",
        className
      )}
      {...props}
    />
  )
}

function useOptionFilter(options: ComboboxOption[]) {
  const { contains } = ComboboxPrimitive.useFilter()
  return options.some((option) => option.keywords?.length)
    ? (option: ComboboxOption, query: string) =>
        [option.label, ...(option.keywords ?? [])].some((text) =>
          contains(text, query)
        )
    : undefined
}

type OptionHoverHandlers = {
  onOptionMouseEnter?: (option: ComboboxOption, anchor: HTMLElement) => void
  onOptionMouseLeave?: () => void
}

export function Combobox({
  options,
  value,
  onValueChange,
  label,
  icon,
  placeholder = "Select…",
  disabled = false,
  variant = "default",
  className,
  onSearchChange,
  popupFooter,
  popupClassName,
  searchPlaceholder,
  virtualized = false,
  listFooter,
  onOptionMouseEnter,
  onOptionMouseLeave,
  onOpenChange,
  attentionRequest = 0,
  showSelectedDescription = false,
  triggerContent,
  open,
}: {
  options: ComboboxOption[]
  value: string | null
  onValueChange: (value: string) => void
  label: string
  icon?: ReactNode
  placeholder?: string
  disabled?: boolean
  variant?: "default" | "toolbar" | "row" | "title" | "title-sm" | "tab"
  triggerContent?: ReactNode
  open?: boolean
  className?: string
  /** Supply server-filtered options in response to this search text. */
  onSearchChange?: (value: string) => void
  popupFooter?: ReactNode
  popupClassName?: string
  searchPlaceholder?: string
  virtualized?: boolean
  /** Content after the options, inside the scrolling viewport. */
  listFooter?: ReactNode
  onOpenChange?: (open: boolean) => void
  /** Increment to focus and briefly shake the trigger after a field error. */
  attentionRequest?: number
  /** Keep an option's distinguishing legend visible after selection. */
  showSelectedDescription?: boolean
} & OptionHoverHandlers) {
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const trigger = triggerRef.current
    if (!attentionRequest || !trigger) return
    trigger.scrollIntoView({ block: "nearest", inline: "nearest" })
    trigger.focus({ preventScroll: true })
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const animation = trigger.animate(
      [0, -5, 5, -4, 4, 0].map((x) => ({ transform: `translateX(${x}px)` })),
      { duration: 320, easing: "ease-in-out" }
    )
    return () => animation.cancel()
  }, [attentionRequest])
  const scrollToIndex = useRef<((index: number) => void) | null>(null)
  const [search, setSearch] = useState("")
  const filter = useOptionFilter(options)
  const orderedOptions = useMemo(
    () => groupOptions(options).flatMap((group) => group.items),
    [options]
  )
  const selected = options.find((option) => option.value === value) ?? null
  const Icon = selected?.icon
  return (
    <ComboboxPrimitive.Root
      open={open}
      items={orderedOptions}
      virtualized={virtualized}
      onItemHighlighted={(_, event) => {
        if (virtualized && event.reason === "keyboard" && event.index >= 0)
          scrollToIndex.current?.(event.index)
      }}
      filter={onSearchChange ? null : filter}
      value={selected}
      inputValue={search}
      onInputValueChange={(value) => {
        onOptionMouseLeave?.()
        setSearch(value)
        onSearchChange?.(value)
      }}
      onOpenChange={(open) => {
        onOpenChange?.(open)
        setSearch("")
        onSearchChange?.("")
      }}
      onValueChange={(option) => {
        if (option) onValueChange(option.value)
      }}
      isItemEqualToValue={(a, b) => a.value === b.value}
      disabled={disabled}
    >
      <ComboboxPrimitive.Trigger
        ref={triggerRef}
        aria-invalid={attentionRequest > 0 || undefined}
        data-slot="combobox-trigger"
        role="combobox"
        aria-label={label}
        title={variant === "toolbar" ? (selected?.label ?? label) : undefined}
        className={cn(
          "flex h-9 w-full items-center gap-2 rounded-md border border-border bg-background px-3 text-left text-sm text-foreground transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          variant === "toolbar" && "h-8 w-auto gap-1.5 px-2 text-xs",
          variant === "tab" && "h-6 w-auto shrink-0 border-0 bg-transparent px-2 text-xs text-foreground-muted hover:bg-muted hover:text-foreground-secondary focus-visible:ring-inset",
          (variant === "title" || variant === "title-sm") &&
            "h-auto w-auto max-w-full border-transparent bg-transparent px-2 py-1 text-2xl font-medium hover:bg-muted",
          variant === "title-sm" && "px-1 text-xl",
          variant === "row" &&
            "h-auto rounded-none border-0 bg-transparent px-6 py-4 hover:bg-muted",
          className,
          attentionRequest > 0 && "border-destructive ring-2 ring-destructive"
        )}
      >
        {triggerContent !== undefined ? triggerContent : <>
        {selected?.leading ?? (
          <span
            aria-hidden="true"
            className="shrink-0 text-foreground-muted empty:hidden [&_svg]:size-4"
          >
            {Icon ? <Icon /> : icon}
          </span>
        )}
        <span
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2",
            variant === "toolbar" && "@max-[640px]/collection:sr-only"
          )}
        >
          <span className="truncate">{selected?.label ?? placeholder}</span>
          {selected?.labelAdornment}
        </span>
        {showSelectedDescription && selected?.description && (
          <span
            title={selected.description}
            className="max-w-[60%] shrink-0 truncate text-xs text-foreground-muted"
          >
            {selected.description}
          </span>
        )}
        {selected?.trailing}
        <ChevronsUpDown
          aria-hidden="true"
          className={cn(
            "size-3.5 shrink-0 text-foreground-muted",
            variant === "toolbar" && "@max-[640px]/collection:hidden"
          )}
        />
        </>}
      </ComboboxPrimitive.Trigger>
      <ComboboxContent
        label={label}
        footer={popupFooter}
        className={popupClassName}
        searchPlaceholder={searchPlaceholder}
        virtualized={virtualized}
        grouped={options.some((option) => option.group)}
        scrollToIndex={scrollToIndex}
        listKey={search}
        listFooter={listFooter}
        onOptionMouseEnter={onOptionMouseEnter}
        onOptionMouseLeave={onOptionMouseLeave}
      />
    </ComboboxPrimitive.Root>
  )
}

function ComboboxContent({
  label,
  anchor,
  searchInput = true,
  disabledValues = [],
  className,
  footer,
  searchPlaceholder = "Search…",
  virtualized = false,
  scrollToIndex,
  listKey,
  listFooter,
  onOptionMouseEnter,
  onOptionMouseLeave,
  emptyContent,
  grouped = false,
}: {
  label: string
  anchor?: ComboboxPrimitive.Positioner.Props["anchor"]
  searchInput?: boolean
  disabledValues?: string[]
  footer?: ReactNode
  searchPlaceholder?: string
  className?: string
  virtualized?: boolean
  scrollToIndex?: RefObject<((index: number) => void) | null>
  listKey?: string
  listFooter?: ReactNode
  emptyContent?: ReactNode
  grouped?: boolean
} & OptionHoverHandlers) {
  const container = useOverlayContainer()
  return (
    <ComboboxPrimitive.Portal container={container?.current ?? undefined}>
      <ComboboxPrimitive.Positioner
        anchor={anchor}
        sideOffset={4}
        align="start"
        className="z-50"
      >
        <ComboboxPrimitive.Popup
          data-slot="combobox-content"
          aria-label={`${label} options`}
          className={cn(
            "w-(--anchor-width) max-w-[calc(100vw-2rem)] min-w-52 overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-md outline-none",
            className
          )}
        >
          <HoverCard<ComboboxOption>>
            {({ payload }) => (
              <>
                {searchInput && (
                  <div className="flex items-center gap-2 border-b border-border px-3">
                    <Search
                      aria-hidden="true"
                      className="size-4 shrink-0 text-foreground-muted"
                    />
                    <ComboboxPrimitive.Input
                      data-slot="combobox-input"
                      aria-label={`Search ${label.toLowerCase()}`}
                      placeholder={searchPlaceholder}
                      className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-foreground-subtle"
                    />
                  </div>
                )}
                <ComboboxPrimitive.Empty>
                  {emptyContent === undefined ? (
                    <p className="p-3 text-sm text-foreground-muted">
                      No options found.
                    </p>
                  ) : (
                    emptyContent
                  )}
                </ComboboxPrimitive.Empty>
                {virtualized ? (
                  <VirtualComboboxList
                    key={listKey}
                    label={label}
                    disabledValues={disabledValues}
                    scrollToIndex={scrollToIndex}
                    footer={listFooter}
                    onOptionMouseEnter={onOptionMouseEnter}
                    onOptionMouseLeave={onOptionMouseLeave}
                  />
                ) : grouped ? (
                  <GroupedComboboxList
                    label={label}
                    disabledValues={disabledValues}
                    onOptionMouseEnter={onOptionMouseEnter}
                    onOptionMouseLeave={onOptionMouseLeave}
                  />
                ) : (
                  <ComboboxPrimitive.List
                    aria-label={`${label} options`}
                    className="max-h-64 overflow-y-auto p-1"
                    onScroll={onOptionMouseLeave}
                  >
                    {(option: ComboboxOption) => (
                      <ComboboxOptionItem
                        key={option.value}
                        option={option}
                        onMouseEnter={(event) =>
                          onOptionMouseEnter?.(option, event.currentTarget)
                        }
                        onMouseLeave={onOptionMouseLeave}
                        disabled={disabledValues.includes(option.value)}
                      />
                    )}
                  </ComboboxPrimitive.List>
                )}
                {footer}
                {payload?.preview && (
                  <HoverCardContent
                    side="right"
                    align="start"
                    role="region"
                    aria-label={`${payload.label} details`}
                    className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
                  >
                    {payload.preview}
                  </HoverCardContent>
                )}
              </>
            )}
          </HoverCard>
        </ComboboxPrimitive.Popup>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  )
}

function GroupedComboboxList({
  label,
  disabledValues,
  onOptionMouseEnter,
  onOptionMouseLeave,
}: { label: string; disabledValues: string[] } & OptionHoverHandlers) {
  const items = ComboboxPrimitive.useFilteredItems<ComboboxOption>()
  return (
    <ComboboxPrimitive.List
      aria-label={`${label} options`}
      className="max-h-64 overflow-y-auto p-1"
      onScroll={onOptionMouseLeave}
    >
      {groupOptions(items).map((group) => (
        <ComboboxGroup key={group.label ?? "ungrouped"} items={group.items}>
          {group.label && <ComboboxLabel>{group.label}</ComboboxLabel>}
          <ComboboxPrimitive.Collection>
            {(option: ComboboxOption) => (
              <ComboboxOptionItem
                key={option.value}
                option={option}
                onMouseEnter={(event) =>
                  onOptionMouseEnter?.(option, event.currentTarget)
                }
                onMouseLeave={onOptionMouseLeave}
                disabled={disabledValues.includes(option.value)}
              />
            )}
          </ComboboxPrimitive.Collection>
        </ComboboxGroup>
      ))}
    </ComboboxPrimitive.List>
  )
}

function ComboboxOptionItem({
  option,
  ...props
}: { option: ComboboxOption } & ComboboxPrimitive.Item.Props & {
    ref?: Ref<HTMLDivElement>
  }) {
  return (
    <ComboboxPrimitive.Item
      value={option}
      render={
        option.preview ? (
          <HoverCardTrigger
            render={<div />}
            payload={option}
            delay={350}
            closeDelay={150}
          />
        ) : undefined
      }
      {...props}
      disabled={option.disabled || props.disabled}
      className="flex cursor-default items-center gap-2 rounded-sm px-2 py-2 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground"
    >
      {option.leading}
      {option.icon && (
        <option.icon
          aria-hidden
          className="size-4 shrink-0 text-foreground-muted"
        />
      )}
      <span className="min-w-0 flex-1 break-words">
        <span
          className={cn(
            option.descriptionBelow && "block truncate",
            (option.labelAdornment || option.trailing) &&
              "flex items-center gap-2"
          )}
        >
          <span
            className={
              option.labelAdornment || option.trailing
                ? "min-w-0 truncate"
                : undefined
            }
          >
            {option.label}
          </span>
          {option.labelAdornment}
        </span>
        {option.descriptionBelow && option.description && (
          <span
            title={option.preview ? undefined : option.description}
            className={cn(
              "block text-xs text-foreground-muted",
              option.descriptionWrap ? "whitespace-normal" : "truncate"
            )}
          >
            {option.description}
          </span>
        )}
      </span>
      {option.badge}
      {option.description && !option.descriptionBelow && (
        <span className="max-w-[60%] shrink-0 truncate text-xs text-foreground-muted">
          {option.description}
        </span>
      )}
      <ComboboxPrimitive.ItemIndicator>
        <Check aria-hidden="true" className="size-3.5" />
      </ComboboxPrimitive.ItemIndicator>
      {option.trailing}
    </ComboboxPrimitive.Item>
  )
}

function VirtualComboboxList({
  label,
  disabledValues,
  scrollToIndex,
  footer,
  onOptionMouseEnter,
  onOptionMouseLeave,
}: {
  label: string
  disabledValues: string[]
  scrollToIndex?: RefObject<((index: number) => void) | null>
  footer?: ReactNode
} & OptionHoverHandlers) {
  const items = ComboboxPrimitive.useFilteredItems<ComboboxOption>()
  const startsGroup = (index: number) =>
    Boolean(
      items[index].group && items[index].group !== items[index - 1]?.group
    )
  const viewport = useRef<HTMLDivElement>(null)
  // TanStack exposes mutable methods that React Compiler must not memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => viewport.current,
    getItemKey: (index) => items[index].value,
    estimateSize: (index) =>
      (items[index].descriptionBelow ? 52 : 36) + (startsGroup(index) ? 28 : 0),
    overscan: 5,
  })
  useEffect(() => {
    if (!scrollToIndex) return
    scrollToIndex.current = (index) =>
      virtualizer.scrollToIndex(index, { align: "auto" })
    return () => {
      scrollToIndex.current = null
    }
  }, [scrollToIndex, virtualizer])
  const visibleGroups = new Map<
    string | undefined,
    ReturnType<typeof virtualizer.getVirtualItems>
  >()
  for (const row of virtualizer.getVirtualItems()) {
    const group = items[row.index].group
    const rows = visibleGroups.get(group) ?? []
    rows.push(row)
    visibleGroups.set(group, rows)
  }
  return (
    <ComboboxPrimitive.List
      ref={viewport}
      aria-label={`${label} options`}
      className="max-h-64 overflow-y-auto overscroll-contain p-1"
      onScroll={onOptionMouseLeave}
    >
      <div
        role="presentation"
        className="relative w-full"
        style={{ height: virtualizer.getTotalSize() }}
      >
        {Array.from(visibleGroups, ([group, rows]) => (
          <ComboboxGroup key={group ?? "ungrouped"} className="contents">
            {group && !rows.some((row) => startsGroup(row.index)) && (
              <ComboboxLabel className="sr-only">{group}</ComboboxLabel>
            )}
            {rows.map((row) => (
              <div
                key={row.key}
                ref={virtualizer.measureElement}
                data-index={row.index}
                role="presentation"
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${row.start}px)` }}
              >
                {startsGroup(row.index) && (
                  <ComboboxLabel>{group}</ComboboxLabel>
                )}
                <ComboboxOptionItem
                  index={row.index}
                  aria-posinset={row.index + 1}
                  aria-setsize={items.length}
                  option={items[row.index]}
                  onMouseEnter={(event) =>
                    onOptionMouseEnter?.(items[row.index], event.currentTarget)
                  }
                  onMouseLeave={onOptionMouseLeave}
                  disabled={disabledValues.includes(items[row.index].value)}
                />
              </div>
            ))}
          </ComboboxGroup>
        ))}
      </div>
      {footer}
    </ComboboxPrimitive.List>
  )
}

export function ComboboxMultiple({
  options,
  value,
  onValueChange,
  label,
  icon,
  placeholder = "Add…",
  disabled = false,
  className,
  minSelected = 0,
  disabledValues = [],
  maxSelected = Infinity,
  onCreate,
  createDescription,
  inputMaxLength,
  triggerContent,
  popupClassName,
  popupFooter,
  emptyContent,
}: Omit<Parameters<typeof Combobox>[0], "value" | "onValueChange"> & {
  value: string[]
  onValueChange: (value: string[]) => void
  disabledValues?: string[]
  minSelected?: number
  maxSelected?: number
  /** Creates and selects a new option in the parent's controlled value. */
  onCreate?: (label: string) => void
  createDescription?: string
  inputMaxLength?: number
  /** A compact button instead of editable chips; search remains in the popup. */
  triggerContent?: ReactNode
  popupClassName?: string
  emptyContent?: ReactNode
}) {
  type MultipleOption = ComboboxOption & { create?: true }
  const anchorRef = useRef<HTMLDivElement>(null)
  const [search, setSearch] = useState("")
  const filter = useOptionFilter(options)
  const orderedOptions = useMemo(
    () => groupOptions(options).flatMap((group) => group.items),
    [options]
  )
  const selected = value.flatMap((item) => {
    const option = options.find((option) => option.value === item)
    return option ? [option] : []
  })
  const minimumReached = selected.length <= minSelected
  const maximumReached = selected.length >= maxSelected
  const query = search.trim()
  const normalise = (text: string) =>
    text.trim().normalize("NFKC").toLowerCase()
  const items: MultipleOption[] =
    onCreate &&
    query &&
    !maximumReached &&
    !options.some((option) => normalise(option.label) === normalise(query))
      ? [
          ...orderedOptions,
          {
            value: query,
            label: `Add ${query}`,
            description: createDescription,
            create: true,
          },
        ]
      : orderedOptions
  return (
    <ComboboxPrimitive.Root<MultipleOption, true>
      multiple
      items={items}
      filter={filter}
      value={selected}
      inputValue={search}
      onInputValueChange={setSearch}
      onOpenChange={() => setSearch("")}
      onValueChange={(next, event) => {
        // Escape closes a surrounding editor; it must not erase saved chips.
        if (event.reason === "escape-key") {
          event.cancel()
          event.allowPropagation()
          return
        }
        if (
          next.length < minSelected ||
          next.length > maxSelected ||
          disabledValues.some(
            (value) =>
              selected.some((option) => option.value === value) &&
              !next.some((option) => option.value === value)
          )
        ) {
          event.cancel()
          return
        }
        const created = next.find((option) => option.create)
        if (created) {
          onCreate?.(created.value)
          setSearch("")
          return
        }
        onValueChange(next.map((option) => option.value))
        setSearch("")
      }}
      isItemEqualToValue={(a, b) =>
        a.value === b.value && a.create === b.create
      }
      disabled={disabled}
    >
      {triggerContent !== undefined ? (
        <ComboboxPrimitive.Trigger
          data-slot="combobox-trigger"
          role="combobox"
          aria-label={label}
          aria-description={
            selected.length
              ? selected.map((option) => option.label).join(", ")
              : "Unassigned"
          }
          className={cn(
            buttonVariants({ variant: "ghost", size: "sm" }),
            "px-1",
            className
          )}
        >
          {triggerContent}
        </ComboboxPrimitive.Trigger>
      ) : (
        <ComboboxPrimitive.Chips
          ref={anchorRef}
          data-disabled={disabled || undefined}
          className={cn(
            "flex min-h-9 w-full items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus-within:ring-2 focus-within:ring-ring data-disabled:opacity-50",
            className
          )}
        >
          {icon && (
            <span
              aria-hidden="true"
              className="shrink-0 px-1 text-foreground-muted [&_svg]:size-4"
            >
              {icon}
            </span>
          )}
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {selected.map((option) => (
              <ComboboxPrimitive.Chip
                key={option.value}
                className="flex min-w-0 max-w-full items-center gap-1 rounded bg-selection px-2 py-1 text-xs text-selection-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {option.icon && (
                  <option.icon aria-hidden className="size-3 shrink-0" />
                )}
                <span className="truncate">{option.label}</span>
                <ComboboxPrimitive.ChipRemove
                  aria-label={`Remove ${option.label}`}
                  disabled={
                    minimumReached || disabledValues.includes(option.value)
                  }
                  className="shrink-0 rounded text-foreground-muted outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-disabled:opacity-40"
                >
                  <X aria-hidden="true" className="size-3" />
                </ComboboxPrimitive.ChipRemove>
              </ComboboxPrimitive.Chip>
            ))}
            <ComboboxPrimitive.Input
              data-slot="combobox-input"
              aria-label={label}
              placeholder={selected.length ? undefined : placeholder}
              maxLength={inputMaxLength}
              className={cn(
                "h-7 w-0 min-w-0 flex-1 bg-transparent px-1 text-sm outline-none placeholder:text-foreground-subtle",
                (!selected.length || search) && "min-w-20"
              )}
            />
          </div>
          <ComboboxPrimitive.Trigger
            data-slot="combobox-trigger"
            aria-label={`Choose ${label.toLowerCase()}`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-foreground-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronsUpDown aria-hidden="true" className="size-3.5" />
          </ComboboxPrimitive.Trigger>
        </ComboboxPrimitive.Chips>
      )}
      <ComboboxContent
        label={label}
        grouped={options.some((option) => option.group)}
        footer={popupFooter}
        emptyContent={emptyContent}
        className={popupClassName}
        anchor={triggerContent === undefined ? anchorRef : undefined}
        searchInput={triggerContent !== undefined}
        disabledValues={[
          ...disabledValues,
          ...(minimumReached ? value : []),
          ...(maximumReached
            ? options
                .filter((option) => !value.includes(option.value))
                .map((option) => option.value)
            : []),
        ]}
      />
    </ComboboxPrimitive.Root>
  )
}
