"use client"

import * as React from "react"
import { SearchBar, type FixedFilter } from "@/components/ui/datool/search-bar"
import {
  collectionFilterFields,
  type FilterResource,
} from "@/src/lib/tracer/collection-filters"

export function CollectionFilterBar({
  resource,
  value,
  onChange,
  isLoading,
  fixedFilters,
  label,
}: {
  resource: FilterResource
  value: string
  onChange: (value: string) => void
  error: string | null
  isLoading?: boolean
  fixedFilters?: readonly FixedFilter[]
  label?: string
}) {
  const fields = React.useMemo(
    () =>
      collectionFilterFields[resource].map((field) => ({
        ...field,
        getValue: () => undefined,
      })),
    [resource]
  )
  return (
    <div
      className="collection-header-filter relative min-w-0 flex-1 [&_.min-w-64]:min-w-0"
      role="search"
      aria-label={label ?? `Filter ${resource}`}
    >
      <SearchBar
        fields={fields}
        fixedFilters={fixedFilters}
        syntax="filter"
        value={value}
        onSearchChange={onChange}
        isLoading={isLoading}
        placeholder="Start typing to search…"
      />
    </div>
  )
}
