import { notFound } from "next/navigation"
import { UiReference } from "./reference"
import { pageMetadata } from "@/lib/page-metadata"

export const metadata = pageMetadata("uiReference")

export default function Page() {
  if (process.env.NODE_ENV !== "development") notFound()
  return <UiReference />
}
