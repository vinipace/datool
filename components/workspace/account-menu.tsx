"use client"

import * as React from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { ChevronsUpDown, LoaderCircle, LogOut } from "lucide-react"

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Notice } from "@/components/ui/notice"
import { SidebarMenuButton } from "@/components/ui/sidebar"
import { UserAvatarImage } from "@/components/ui/user-avatar"
import { authClient } from "@/lib/auth-client"

export type AccountMenuUser = {
  name: string
  email: string
  image?: string | null
}

export function AccountMenu({ user }: { user: AccountMenuUser }) {
  const router = useRouter()
  const [isPending, setIsPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const name = user.name.trim() || user.email

  async function signOut() {
    if (isPending) return
    setIsPending(true)
    setError(null)
    try {
      const result = await authClient.signOut()
      if (result.error) throw result.error
      router.replace("/sign-in")
      router.refresh()
    } catch {
      setError("Unable to sign out. Try again.")
      setIsPending(false)
    }
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <SidebarMenuButton
            size="lg"
            aria-label={`Account menu for ${user.email}`}
            aria-busy={isPending}
          >
            <UserAvatarImage name={name} image={user.image ?? null} />
            <span className="grid min-w-0 flex-1 text-xs leading-4">
              <span className="truncate font-medium">{name}</span>
              <span className="truncate text-foreground-muted">{user.email}</span>
            </span>
            {isPending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <ChevronsUpDown />
            )}
          </SidebarMenuButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          side="top"
          className="w-(--radix-dropdown-menu-trigger-width) min-w-56 max-w-[calc(100vw-2rem)]"
        >
          <DropdownMenuLabel className="font-normal">
            <span className="block text-xs text-foreground-muted">Signed in as</span>
            <span className="block wrap-anywhere font-medium">{name}</span>
            <span className="block wrap-anywhere text-xs text-foreground-muted">
              {user.email}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild><Link href="/members">Members</Link></DropdownMenuItem>
          <DropdownMenuItem asChild><Link href="/billing">Billing</Link></DropdownMenuItem>
          <DropdownMenuItem
            disabled={isPending}
            onSelect={(event) => {
              event.preventDefault()
              void signOut()
            }}
          >
            {isPending ? <LoaderCircle className="animate-spin" /> : <LogOut />}
            {isPending ? "Signing out…" : "Sign out"}
          </DropdownMenuItem>
          {error ? <Notice variant="error" role="alert">{error}</Notice> : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}
