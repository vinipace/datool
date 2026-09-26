"use client"

import type { ReactNode } from "react"
import { RootProvider } from "fumadocs-ui/provider/next"
import { useDocsSearch } from "fumadocs-core/search/client"
import { fetchClient } from "fumadocs-core/search/client/fetch"
import {
  SearchDialog,
  SearchDialogClose,
  SearchDialogContent,
  SearchDialogHeader,
  SearchDialogIcon,
  SearchDialogInput,
  SearchDialogList,
  SearchDialogOverlay,
  type SharedProps,
} from "fumadocs-ui/components/dialog/search"
import { Notice } from "@/components/ui/notice"

const client = fetchClient({ api: "/api/docs/search" })
const suggestions = [
  {
    id: "quickstart",
    type: "page" as const,
    content: "Send your first trace",
    url: "/docs/get-started/first-trace",
  },
  {
    id: "cli",
    type: "page" as const,
    content: "CLI reference",
    url: "/docs/reference/cli",
  },
  {
    id: "mcp",
    type: "page" as const,
    content: "Connect an MCP client",
    url: "/docs/reference/mcp",
  },
]

function DocsSearchDialog(props: SharedProps) {
  const { search, setSearch, query } = useDocsSearch({ client })
  return (
    <SearchDialog
      {...props}
      search={search}
      onSearchChange={setSearch}
      isLoading={query.isLoading}
    >
      <SearchDialogOverlay />
      <SearchDialogContent>
        <SearchDialogHeader>
          <SearchDialogIcon />
          <SearchDialogInput
            aria-label="Search documentation"
            placeholder="Search documentation…"
          />
          <SearchDialogClose />
        </SearchDialogHeader>
        {query.error ? (
          <Notice
            className="m-4"
            variant="error"
            role="alert"
            title="Search is unavailable"
          >
            Check your connection and try another search. You can also browse
            the sidebar.
          </Notice>
        ) : (
          <SearchDialogList
            items={query.data === "empty" ? suggestions : query.data}
          />
        )}
      </SearchDialogContent>
    </SearchDialog>
  )
}

export function DocsProvider({ children }: { children: ReactNode }) {
  return (
    <RootProvider
      theme={{ enabled: false }}
      search={{ SearchDialog: DocsSearchDialog }}
    >
      {children}
    </RootProvider>
  )
}
