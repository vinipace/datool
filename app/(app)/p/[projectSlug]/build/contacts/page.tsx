import { pageMetadata } from "@/lib/page-metadata"
import { ContactsPage } from "@/components/build/operations/contacts-page"

export const metadata = pageMetadata("buildContacts")

export default async function BuildContactsRoute({ params }: { params: Promise<{ projectSlug: string }> }) {
  await params
  return <ContactsPage />
}
