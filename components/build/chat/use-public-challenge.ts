"use client"
import * as React from "react"
import { PublicChallenge, type Challenge } from "./public-challenge"

export function usePublicChallenge() {
  const [challenge, setChallenge] = React.useState<Challenge | null>(null)
  const pending = React.useRef<{
    resolve: (token: string) => void
    reject: (error: Error) => void
  } | null>(null)
  const reject = React.useCallback(() => {
    pending.current?.reject(
      new Error("Security check was not completed. Please try again.")
    )
    pending.current = null
    setChallenge(null)
  }, [])
  const resolve = React.useCallback((token: string) => {
    pending.current?.resolve(token)
    pending.current = null
    setChallenge(null)
  }, [])
  const verify = React.useCallback(
    (value: Challenge) =>
      new Promise<string>((yes, no) => {
        pending.current?.reject(new Error("Another security check started."))
        pending.current = { resolve: yes, reject: no }
        setChallenge(value)
      }),
    []
  )
  React.useEffect(
    () => () => {
      pending.current?.reject(new Error("Chat closed."))
    },
    []
  )
  return {
    verify,
    element: React.createElement(PublicChallenge, {
      challenge,
      resolve,
      reject,
    }),
  }
}
