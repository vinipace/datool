/* THIS FILE FOLLOWS PAYLOAD'S GENERATED APP ROUTER SHELL. */

import config from "@payload-config"
import { generatePageMetadata, RootPage } from "@payloadcms/next/views"
import type { Metadata } from "next"
import { notFound } from "next/navigation"
import { cmsEnabled } from "@/lib/cms/config"

export const dynamic = "force-dynamic"

import { importMap } from "../importMap"

type Args = {
  params: Promise<{
    segments: string[]
  }>
  searchParams: Promise<{
    [key: string]: string | string[]
  }>
}

export const generateMetadata = ({
  params,
  searchParams,
}: Args): Promise<Metadata> => {
  if (!cmsEnabled()) notFound()
  return generatePageMetadata({ config, params, searchParams })
}

export default function PayloadAdminPage({ params, searchParams }: Args) {
  if (!cmsEnabled()) notFound()
  return RootPage({ config, params, searchParams, importMap })
}
