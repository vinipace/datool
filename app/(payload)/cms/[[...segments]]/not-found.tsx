/* THIS FILE FOLLOWS PAYLOAD'S GENERATED APP ROUTER SHELL. */

import config from "@payload-config"
import { NotFoundPage } from "@payloadcms/next/views"
import { cmsEnabled } from "@/lib/cms/config"

import { importMap } from "../importMap"

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export default function PayloadAdminNotFound({ params, searchParams }: Args) {
  if (!cmsEnabled()) return null
  return NotFoundPage({ config, params, searchParams, importMap })
}
