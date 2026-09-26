import { SettingsShell } from "@/components/workspace/settings-shell"
import { requireActiveOrganization } from "@/lib/workspace-access"

export default async function Layout({
  children,
}: {
  children: React.ReactNode
}) {
  const { organization, billingRedirect } =
    await requireActiveOrganization("/settings/general")
  if (billingRedirect) return children

  return (
    <SettingsShell
      title="Organization settings"
      backHref="/projects"
      organization={organization}
    >
      {children}
    </SettingsShell>
  )
}
