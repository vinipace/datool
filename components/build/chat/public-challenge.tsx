"use client"

import * as React from "react"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog"

export type Challenge = { siteKey: string; connectionId: string }
type Turnstile = {
  render: (element: HTMLElement, options: Record<string, unknown>) => string
  remove: (id: string) => void
}

function ChallengeWidget({
  challenge,
  resolve,
  reject,
}: {
  challenge: Challenge
  resolve: (token: string) => void
  reject: () => void
}) {
  const container = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    let disposed = false
    let widget: string | undefined
    const api = () => (window as Window & { turnstile?: Turnstile }).turnstile
    const render = () => {
      if (disposed || !container.current || !api()) return
      widget = api()!.render(container.current, {
        sitekey: challenge.siteKey,
        action: "datool_chat",
        cData: challenge.connectionId,
        callback: resolve,
        "error-callback": reject,
        "expired-callback": reject,
        theme: "auto",
        size: "flexible",
      })
    }
    let script = document.querySelector<HTMLScriptElement>(
      "script[data-datool-turnstile]"
    )
    if (api()) render()
    else {
      if (!script) {
        script = document.createElement("script")
        script.src =
          "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
        script.dataset.datoolTurnstile = "true"
        script.async = true
        document.head.appendChild(script)
      }
      script.addEventListener("load", render)
      script.addEventListener("error", reject)
    }
    const failed = () => {
      script?.remove()
      reject()
    }
    script?.addEventListener("error", failed)
    const timeout = window.setTimeout(reject, 120_000)
    return () => {
      disposed = true
      window.clearTimeout(timeout)
      script?.removeEventListener("load", render)
      script?.removeEventListener("error", reject)
      script?.removeEventListener("error", failed)
      if (widget) api()?.remove(widget)
    }
  }, [challenge, resolve, reject])
  return <div ref={container} className="min-h-16" />
}

export function PublicChallenge({
  challenge,
  resolve,
  reject,
}: {
  challenge: Challenge | null
  resolve: (token: string) => void
  reject: () => void
}) {
  return (
    <Dialog
      open={Boolean(challenge)}
      onOpenChange={(open) => {
        if (!open) reject()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Security check</DialogTitle>
          <DialogDescription>
            Verify that you’re a person to start chatting.
          </DialogDescription>
        </DialogHeader>
        {challenge && (
          <ChallengeWidget
            challenge={challenge}
            resolve={resolve}
            reject={reject}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}
