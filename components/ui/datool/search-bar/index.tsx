"use client"

import type { Ref } from "react"

import {
  DataTableSearchInput,
  type DataTableSearchInputHandle,
} from "./search-input"
import type { SearchField } from "./search-core"
import { TokenFilterInput } from "./token-filter-input"
import type { FixedFilter } from "./filter-draft"

export type { FixedFilter } from "./filter-draft"

export type {
  SearchField,
  SearchFieldKind,
  SearchFieldSpec,
} from "./search-core"

export type SearchBarHandle = DataTableSearchInputHandle

export type SearchBarProps<Row extends Record<string, unknown>> = {
  syntax?: "search" | "filter"
  className?: string
  fields: SearchField<Row>[]
  fixedFilters?: readonly FixedFilter[]
  inputRef?: Ref<SearchBarHandle>
  isLoading?: boolean
  onSearchChange: (value: string) => void
  placeholder?: string
  value: string
}

/**
 * Controlled token-aware search bar.
 */
export function SearchBar<Row extends Record<string, unknown>>({
  syntax,
  className,
  fields,
  fixedFilters,
  inputRef,
  isLoading,
  onSearchChange,
  placeholder,
  value,
}: SearchBarProps<Row>) {
  const Component = syntax === "filter" ? TokenFilterInput : DataTableSearchInput
  return (
    <div className={`${className ?? "min-w-0 flex-1"} [&_.is-editor-empty:first-child]:before:pointer-events-none [&_.is-editor-empty:first-child]:before:float-left [&_.is-editor-empty:first-child]:before:h-0 [&_.is-editor-empty:first-child]:before:text-foreground-muted [&_.is-editor-empty:first-child]:before:content-[attr(data-placeholder)]`}>
      <Component
        syntax={syntax}
        fields={fields}
        fixedFilters={fixedFilters}
        inputRef={inputRef}
        isLoading={isLoading}
        onSearchChange={onSearchChange}
        placeholder={placeholder}
        value={value}
      />
    </div>
  )
}
