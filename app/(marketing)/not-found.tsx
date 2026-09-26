import Link from "next/link"
import { Button } from "@/components/ui/button"
export default function NotFound() {
  return (
    <div className="py-24">
      <h1 className="text-3xl font-semibold">Page not found</h1>
      <p className="my-6 text-foreground-muted">This page isn’t available.</p>
      <Button asChild>
        <Link href="/">Back to Datool</Link>
      </Button>
    </div>
  )
}
