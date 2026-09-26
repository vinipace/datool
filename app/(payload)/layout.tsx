/* THIS FILE FOLLOWS PAYLOAD'S GENERATED APP ROUTER SHELL. */
import config from "@payload-config"
import "@payloadcms/next/css"
import { handleServerFunctions, RootLayout } from "@payloadcms/next/layouts"
import type { ServerFunctionClient } from "payload"
import { notFound } from "next/navigation"
import { cmsEnabled } from "@/lib/cms/config"

import { importMap } from "./cms/importMap.js"

type Args = {
  children: React.ReactNode
}

const serverFunction: ServerFunctionClient = async (args) => {
  "use server"
  if (!cmsEnabled()) notFound()
  return handleServerFunctions({
    ...args,
    config,
    importMap,
  })
}

export default function PayloadRootLayout({ children }: Args) {
  if (!cmsEnabled()) notFound()
  return (
    <RootLayout
      config={config}
      importMap={importMap}
      serverFunction={serverFunction}
    >
      {children}
    </RootLayout>
  )
}
