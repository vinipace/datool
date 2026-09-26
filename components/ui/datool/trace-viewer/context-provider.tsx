'use client';

import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { CustomPanelContext, TraceViewerContext, initialState, reducer, type TraceViewerContextProps } from './context';
import type { GetQuickLinks, MemoCacheKey, QuickLink, ScrollSnapshot, SpanNode, VisibleSpanEvent } from './types';

export function TraceViewerContextProvider({
  getQuickLinks,
  withPanel = false,
  children,
  customSpanClassNameFunc,
  customSpanEventClassNameFunc,
  customPanelComponent = null,
}: {
  getQuickLinks?: GetQuickLinks;
  withPanel?: boolean;
  children: ReactNode;
  customSpanClassNameFunc?: (span: SpanNode) => string;
  customSpanEventClassNameFunc?: (event: VisibleSpanEvent) => string;
  customPanelComponent?: ReactNode;
}): ReactNode {
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef<ScrollSnapshot>(undefined);
  const memoCacheRef = useRef(new Map<string, MemoCacheKey>());
  const quickLinksCache = useRef(new WeakMap<GetQuickLinks, Map<string, QuickLink[]>>());
  const cachedQuickLinks = useCallback<GetQuickLinks>((span) => {
    if (!getQuickLinks) return [];
    let cache = quickLinksCache.current.get(getQuickLinks);
    if (!cache) {
      cache = new Map();
      quickLinksCache.current.set(getQuickLinks, cache);
    }
    const existing = cache.get(span.spanId);
    if (existing) return existing;
    const links = getQuickLinks(span);
    cache.set(span.spanId, links);
    return links;
  }, [getQuickLinks]);
  const [state, dispatch] = useReducer(reducer, initialState, (initial) => {
    return {
      ...initial,
      timelineRef,
      scrollSnapshotRef,
      customSpanClassNameFunc,
      customSpanEventClassNameFunc,
      memoCacheRef,
      withPanel,

    };
  });

  useEffect(
    () =>
      dispatch({
        type: 'setWithPanel',
        withPanel,
      }),
    [withPanel]
  );

  const value: TraceViewerContextProps = useMemo(
    () => ({ state: { ...state, getQuickLinks: cachedQuickLinks }, dispatch }),
    [state, dispatch, cachedQuickLinks]
  );

  return (
    <CustomPanelContext.Provider value={customPanelComponent}>
      <TraceViewerContext.Provider value={value}>
        {children}
      </TraceViewerContext.Provider>
    </CustomPanelContext.Provider>
  );
}

