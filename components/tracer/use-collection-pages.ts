"use client"

import * as React from "react"
import type { ApiList } from "@/src/lib/tracer/contracts"
import type { CollectionListOptions } from "./api"

/** Shared server-filtered cursor pagination with refresh and stale-response isolation. */
export function useCollectionPages<
  T extends { id: string },
  Page extends ApiList<T> = ApiList<T>,
>(
  list: (options: CollectionListOptions) => Promise<ApiList<T> & Page>,
  filter: string,
  intervalMs = 3_000,
  options: {
    refreshLoadedPages?: boolean
    shouldPoll?: (page: Page | null) => boolean
  } = {}
) {
  const [state, setState] = React.useState({
    pages: [] as Page[],
    error: null as Error | null,
    loadMoreError: null as Error | null,
    isLoading: true,
    isRefreshing: false,
    isFetching: false,
    isLoadingMore: false,
  })
  const actions = React.useRef({ refresh: () => {}, loadMore: () => {} })
  const shouldPoll = React.useEffectEvent(
    (page: Page | null) => options.shouldPoll?.(page) ?? true
  )
  const refreshLoadedPages = options.refreshLoadedPages ?? false
  React.useEffect(() => {
    let active = true
    const controller = new AbortController()
    let busy = false
    let refreshQueued = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let pages: Page[] = []
    const asError = (error: unknown) =>
      error instanceof Error ? error : new Error("Unable to load collection.")
    queueMicrotask(
      () =>
        active &&
        setState({
          pages: [],
          error: null,
          loadMoreError: null,
          isLoading: true,
          isRefreshing: false,
          isFetching: false,
          isLoadingMore: false,
        })
    )
    async function refresh(background = false) {
      if (busy) {
        if (!background) refreshQueued = true
        return
      }
      busy = true
      setState((current) => ({
        ...current,
        isFetching: true,
        ...(!background && {
          error: null,
          isLoading: !pages.length,
          isRefreshing: !!pages.length,
        }),
      }))
      try {
        const page = await list({
          filter,
          limit: 50,
          signal: controller.signal,
          includeTotal: !background,
        })
        if (!active) return
        failures = 0
        const refreshed: Page[] = [
          { ...page, total: page.total ?? pages[0]?.total },
        ]
        if (refreshLoadedPages) {
          while (
            refreshed.length < pages.length &&
            refreshed.at(-1)?.nextCursor
          ) {
            refreshed.push(
              await list({
                filter,
                limit: 50,
                cursor: refreshed.at(-1)!.nextCursor!,
                signal: controller.signal,
              })
            )
          }
        }
        if (!active) return
        pages = refreshed
        setState((current) => ({
          ...current,
          pages,
          error: null,
          loadMoreError: background ? current.loadMoreError : null,
        }))
      } catch (error) {
        failures++
        if (active)
          setState((current) => ({ ...current, error: asError(error) }))
      } finally {
        busy = false
        if (active)
          setState((current) => ({
            ...current,
            isLoading: false,
            isRefreshing: false,
            isFetching: false,
          }))
        drainRefresh()
      }
    }
    async function loadMore() {
      const cursor = pages.at(-1)?.nextCursor
      if (busy || !cursor) return
      busy = true
      setState((current) => ({
        ...current,
        isLoadingMore: true,
        isFetching: true,
        loadMoreError: null,
      }))
      try {
        const page = await list({
          filter,
          cursor,
          limit: 50,
          signal: controller.signal,
        })
        if (!active) return
        pages = [...pages, page]
        setState((current) => ({ ...current, pages }))
      } catch (error) {
        if (active)
          setState((current) => ({ ...current, loadMoreError: asError(error) }))
      } finally {
        busy = false
        if (active)
          setState((current) => ({
            ...current,
            isLoadingMore: false,
            isFetching: false,
          }))
        drainRefresh()
      }
    }
    function drainRefresh() {
      if (!active || !refreshQueued) return
      refreshQueued = false
      queueMicrotask(() => {
        if (active) void refresh()
      })
    }
    actions.current = {
      refresh: () => void refresh(),
      loadMore: () => void loadMore(),
    }
    const schedule = () => {
      if (!active || intervalMs <= 0) return
      timer = setTimeout(
        async () => {
          if (
            !busy &&
            document.visibilityState !== "hidden" &&
            (refreshLoadedPages || pages.length <= 1) &&
            shouldPoll(pages[0] ?? null)
          )
            await refresh(true)
          schedule()
        },
        Math.min(60_000, intervalMs * 2 ** Math.min(failures, 4)) *
          (0.9 + Math.random() * 0.2)
      )
    }
    queueMicrotask(() => {
      if (active) void refresh().finally(schedule)
    })
    const autoRefresh = () => {
      if (
        !busy &&
        document.visibilityState !== "hidden" &&
        (refreshLoadedPages || pages.length <= 1) &&
        shouldPoll(pages[0] ?? null)
      )
        void refresh(true)
    }
    document.addEventListener("visibilitychange", autoRefresh)
    return () => {
      active = false
      controller.abort()
      document.removeEventListener("visibilitychange", autoRefresh)
      clearTimeout(timer)
    }
  }, [list, filter, intervalMs, refreshLoadedPages])

  const items = React.useMemo(() => {
    const seen = new Set<string>()
    return state.pages
      .flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.id)) return false
        seen.add(item.id)
        return true
      })
  }, [state.pages])
  return {
    ...state,
    items,
    data: state.pages[0] ?? null,
    total: state.pages[0]?.total ?? null,
    isLive: refreshLoadedPages || state.pages.length <= 1,
    canLoadMore: !!state.pages.at(-1)?.nextCursor,
    refresh: () => actions.current.refresh(),
    loadMore: () => actions.current.loadMore(),
  }
}
