import { notFound } from "next/navigation"
import { DefaultTemplate } from "@payloadcms/next/templates"
import { Gutter, Link, NavGroup } from "@payloadcms/ui"
import type { AdminViewServerProps, ServerProps } from "payload"
import { isSystemAdmin } from "./access"
import { getSystemOrganization, getSystemOverview } from "./system-data"
import {
  SystemDataError,
  SystemOrganizationPage,
  SystemOverviewPage,
} from "@/components/cms/system-overview"
import styles from "@/components/ui/cms-system.module.css"

export function SystemNavigation({ user, params }: ServerProps) {
  if (!isSystemAdmin(user)) return null
  const section = Array.isArray(params?.segments)
    ? params.segments[0]
    : undefined
  return (
    <NavGroup label="System oversight">
      <div className={styles.nav}>
        <Link
          href="/cms/subscriptions"
          aria-current={
            section === "subscriptions" || section === "organizations"
              ? "page"
              : undefined
          }
        >
          Subscriptions
        </Link>
        <Link
          href="/cms/usage"
          aria-current={section === "usage" ? "page" : undefined}
        >
          Organization usage
        </Link>
      </div>
    </NavGroup>
  )
}

async function SystemView(
  props: AdminViewServerProps,
  view: "subscriptions" | "usage" | "organization"
) {
  const { req, visibleEntities } = props.initPageResult
  if (!isSystemAdmin(req.user)) notFound()
  let content
  try {
    if (view === "organization") {
      const segments = props.params?.segments
      const id = Array.isArray(segments) ? segments[1] : undefined
      const data = id ? await getSystemOrganization(req.user, id) : null
      if (!data) content = null
      else content = <SystemOrganizationPage data={data} />
    } else {
      const params = {
        ...props.searchParams,
        sort: props.searchParams?.sort ?? (view === "usage" ? "usage" : "name"),
      }
      content = (
        <SystemOverviewPage
          data={await getSystemOverview(req.user, params)}
          view={view}
        />
      )
    }
  } catch {
    console.error("System overview query failed.")
    content = <SystemDataError />
  }
  if (!content) notFound()
  return (
    <DefaultTemplate
      {...props}
      req={req}
      user={req.user ?? undefined}
      permissions={props.initPageResult.permissions}
      visibleEntities={visibleEntities}
    >
      <Gutter>{content}</Gutter>
    </DefaultTemplate>
  )
}

export const SubscriptionsView = (props: AdminViewServerProps) =>
  SystemView(props, "subscriptions")
export const UsageView = (props: AdminViewServerProps) =>
  SystemView(props, "usage")
export const OrganizationView = (props: AdminViewServerProps) =>
  SystemView(props, "organization")
