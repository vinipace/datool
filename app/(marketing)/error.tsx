"use client"
import { Button } from "@/components/ui/button"
export default function ErrorPage({ retry }: { retry: () => void }) {
  return (
    <div className="py-24">
      <h1 className="text-3xl font-semibold">This page couldn’t load</h1>
      <p role="alert" className="my-6 text-foreground-muted">
        Please try again in a moment.
      </p>
      <Button onClick={retry}>Try again</Button>
    </div>
  )
}
