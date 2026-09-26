'use client';

import type { CSSProperties, MutableRefObject } from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';

const emptyStyle: CSSProperties = Object.freeze({});

type SetStyle = (propertyName: string, value: string | undefined) => void;

interface ImmediateStyle {
  setStyle: SetStyle;
  styleRef: MutableRefObject<CSSProperties>;
  style: CSSProperties;
}

/**
 * Update an element's style without forcing renders, but in a way that is still
 * safe if the element re-renders for another reason.
 * @returns The current style & a method to update the style
 */
export function useImmediateStyle(
  ref: MutableRefObject<HTMLElement | null>
): ImmediateStyle {
  const styleRef = useRef<CSSProperties>({});
  const setStyle = useCallback<SetStyle>(
    (propertyName, value) => {
      // @ts-expect-error typeof keyof CSSProperties is too big of a union
      styleRef.current[propertyName] = value;
      if (!ref.current) return;
      if (!value) {
        ref.current.style.removeProperty(propertyName);
        return;
      }
      ref.current.style.setProperty(propertyName, value);
    },
    [ref]
  );

  // Replay imperative styles after a React commit without reading refs during
  // render or causing a React update for every pointer/scroll event.
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    for (const [property, value] of Object.entries(styleRef.current)) {
      if (value === undefined) element.style.removeProperty(property);
      else element.style.setProperty(property, String(value));
    }
  });

  return { setStyle, styleRef, style: emptyStyle };
}
