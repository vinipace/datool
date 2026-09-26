"use client"

import { workspacePrefix } from "@/lib/workspace-routing"
import { useProjectScope } from "./project-scope-context"
import { usePathname } from "next/navigation"

export function useWorkspaceHref() {
  const pathname = usePathname()
  const prefix = workspacePrefix(pathname)

  return (path: string) => (prefix ? `${prefix}${path}` : "/")
}

export function useWorkspaceStorageScope() {
  const scope = useProjectScope()
  return scope
    ? `${encodeURIComponent(scope.organizationId)}:${encodeURIComponent(scope.projectId)}`
    : "unscoped"
}
