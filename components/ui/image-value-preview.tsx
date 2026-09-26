"use client"

import { useState } from "react"
import { Notice } from "./notice"

export function ImageValuePreview({ url, alt }: { url: string; alt: string }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null)
  if (failedUrl === url)
    return (
      <Notice variant="error">
        Could not display this image. Its original value is available in JSON.
      </Notice>
    )
  return (
    // Captured data URLs and external image evidence must not pass through Next's optimizer.
    <img
      src={url}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailedUrl(url)}
      className="mx-auto max-h-[32rem] max-w-full rounded-lg object-contain"
    />
  )
}
