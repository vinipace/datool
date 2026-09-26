"use client"

import { usePathname } from "next/navigation"
import { SignInLoading } from "@/components/auth/sign-in-loading"
import { WorkspaceLoading } from "@/components/tracer/workspace-loading"
import ProjectSetupLoading from "./projects/loading"

// This outer fallback can appear before a route's own loading module is ready.
export default function Loading() {
  const pathname = usePathname()
  if (pathname === "/sign-in" || pathname === "/sign-up")
    return <SignInLoading />
  if (pathname === "/projects") return <ProjectSetupLoading />
  return <WorkspaceLoading />
}
