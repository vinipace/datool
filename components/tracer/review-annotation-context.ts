"use client"

import { createContext, useContext, useState } from "react"
import type {
  AnnotationReference,
  ReviewAnnotationInput,
} from "@/src/lib/tracer/review-annotations"

export type AnnotationFocus = {
  id: string
  reference: AnnotationReference
  nonce: number
}
export type AnnotationContext = {
  annotations: ReviewAnnotationInput[]
  focus: AnnotationFocus | null
  draft: AnnotationReference | null
  disabled: boolean
  setDraft: (reference: AnnotationReference | null) => void
  setFocus: (focus: AnnotationFocus | null) => void
}
export const ReviewAnnotationContext = createContext<AnnotationContext | null>(
  null
)
export const useReviewAnnotations = () => useContext(ReviewAnnotationContext)

/** A new reference opens Overview once; subsequent manual tab changes still work. */
export function useReviewAnnotationTab<T extends string>(
  stored: T,
  select: (tab: T) => void,
  target: T
): readonly [T, (tab: T) => void] {
  const focus = useReviewAnnotations()?.focus ?? null
  const [dismissed, setDismissed] = useState<AnnotationFocus | null>(null)
  return [
    focus && focus !== dismissed ? target : stored,
    (tab) => {
      setDismissed(focus)
      select(tab)
    },
  ]
}
