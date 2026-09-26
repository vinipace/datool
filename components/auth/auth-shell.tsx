import type { ReactNode } from "react"
import Image from "next/image"
import datoolLogo from "@/app/icon.svg"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/components/ui/card"

export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-background px-5 py-12 text-foreground">
      <div className="grid w-full max-w-sm gap-6">
        <div className="flex items-center justify-center gap-3">
          <Image
            src={datoolLogo}
            alt=""
            width={48}
            height={48}
            unoptimized
            className="size-12 shrink-0"
          />
          <span className="text-4xl font-semibold tracking-tight">datool</span>
        </div>
        <Card>
          <CardHeader className="px-8 pt-8 text-center">
            <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
            {description && <CardDescription>{description}</CardDescription>}
          </CardHeader>
          <CardContent className="px-8 pb-8">{children}</CardContent>
        </Card>
        {footer && (
          <div className="text-center text-sm text-foreground-muted">
            {footer}
          </div>
        )}
      </div>
    </main>
  )
}
