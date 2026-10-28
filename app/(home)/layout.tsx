import "../globals.css"
import { headers } from "next/headers"
import { Document } from "@/app/document"
import { cmsEnabled } from "@/lib/cms/config"
import { getWorkspaceSession } from "@/lib/workspace-access"

export { metadata } from "@/app/(app)/layout"

// Signed-out visitors to / get the light marketing home; everyone else keeps the
// app's dark theme. The proxy sets the requested path on every request.
export default async function HomeLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const marketing =
    cmsEnabled() &&
    (await headers()).get("x-datool-workspace-path") === "/" &&
    !(await getWorkspaceSession())
  return <Document theme={marketing ? "light" : "dark"}>{children}</Document>
}
