import { google } from "better-auth/social-providers"
import { isAllowedEmail, isAllowedGoogleUser } from "./launch-access"
import {
  authEmailConfigured,
  sendSignInLink,
  signInLinkExpirySeconds,
} from "./email"
import { betterAuth } from "better-auth"
import {
  createAuthMiddleware,
  APIError,
  getSessionFromCtx,
} from "better-auth/api"
import { jwt, magicLink, organization } from "better-auth/plugins"
import { createAccessControl } from "better-auth/plugins/access"
import {
  defaultStatements,
  ownerAc,
  adminAc,
  memberAc,
} from "better-auth/plugins/organization/access"
import { oauthProvider } from "@better-auth/oauth-provider"
import { apiKey } from "@better-auth/api-key"
import { selectedOAuthProject } from "./oauth-context"
import type { Pool } from "pg"
import { nextCookies } from "better-auth/next-js"
import {
  mcpScopes,
  roleScopes,
  workspaceScopes,
} from "@/src/lib/auth/permissions"
import {
  invitationLifetimeSeconds,
  requireInvitationEmail,
  sendInvitationEmail,
} from "./invitation-email"
import { hasInvitationSignInAccess } from "./invitation-access"
import { organizationDetailsSchema } from "@/src/lib/organization-settings"

export function authBaseUrl() {
  const url = new URL(process.env.BETTER_AUTH_URL || "http://localhost:3000")
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("BETTER_AUTH_URL requires HTTPS except on loopback.")
  return url.origin
}
export async function memberRole(
  database: Pool,
  userId: string,
  organizationId: string
) {
  const result = await database.query<{ role: string }>(
    'select role from member where "userId" = $1 and "organizationId" = $2',
    [userId, organizationId]
  )
  return result.rows[0]?.role
}
const ac = createAccessControl({
  ...defaultStatements,
  apiKey: ["create", "read", "update", "delete"],
})
export function organizationAuthOptions(
  database: Pool,
  options?: { baseURL?: string; secret?: string }
) {
  const baseURL = options?.baseURL ?? authBaseUrl()
  const resource = `${baseURL}/api/mcp`
  const secret = options?.secret ?? process.env.BETTER_AUTH_SECRET
  if (!secret || secret.length < 32)
    throw new Error(
      "Set BETTER_AUTH_SECRET to a random secret of at least 32 characters."
    )
  return {
    database,
    emailAndPassword: { enabled: false },
    baseURL,
    secret,
    trustedOrigins: [baseURL],
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/organization/invite-member") {
          const session = await getSessionFromCtx(ctx)
          const organizationId =
            ctx.body?.organizationId ?? session?.session.activeOrganizationId
          const role =
            session && organizationId
              ? await memberRole(database, session.user.id, organizationId)
              : undefined
          if (
            role
              ?.split(",")
              .some((value) => ["owner", "admin"].includes(value.trim()))
          ) {
            requireInvitationEmail()
            if (ctx.body?.resend && typeof ctx.body.email === "string") {
              const recent = await database.query(
                `SELECT 1 FROM invitation i JOIN invitation_email e ON e.invitation_id=i.id
                WHERE i."organizationId"=$1 AND i.email=$2 AND i.status='pending' AND i."expiresAt">now()
                  AND e.sent_at>now()-interval '1 minute'`,
                [organizationId, ctx.body.email.toLowerCase()]
              )
              if (recent.rowCount)
                throw new APIError("TOO_MANY_REQUESTS", {
                  message:
                    "An invitation email was just sent. Wait one minute before resending.",
                })
            }
          }
        }
        if (ctx.path === "/sign-in/magic-link") {
          if (!authEmailConfigured())
            throw new APIError("SERVICE_UNAVAILABLE", {
              code: "EMAIL_SIGN_IN_UNAVAILABLE",
              message:
                "Email sign-in is currently unavailable. Please try Google.",
            })
          if (typeof ctx.body?.email !== "string") return
          const email = ctx.body.email.trim().toLowerCase()
          if (!isAllowedEmail(email))
            throw new APIError("FORBIDDEN", {
              code: "EMAIL_DOMAIN_NOT_ALLOWED",
              message: "Email sign-in is not available for this address.",
            })
          ctx.body.email = email
          return
        }
        if (ctx.path !== "/api-key/create") return
        const organizationId = ctx.body?.organizationId
        if (typeof organizationId !== "string")
          throw new APIError("BAD_REQUEST", {
            message: "Organization is required.",
          })
        const policy = await database.query<{ creation_disabled: boolean }>(
          "SELECT creation_disabled FROM organization_key_policy WHERE organization_id = $1",
          [organizationId]
        )
        if (policy.rows[0]?.creation_disabled)
          throw new APIError("FORBIDDEN", {
            message: "API key creation is disabled for this organization.",
          })
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/organization/invite-member") return
        const result = ctx.context.returned
        if (
          !result ||
          result instanceof APIError ||
          typeof result !== "object" ||
          !("id" in result) ||
          typeof result.id !== "string"
        )
          return
        // Better Auth catches email-hook errors. Check durable provider acceptance
        // here so both the HTTP and server APIs return an actionable failure.
        const delivery = await database.query(
          "SELECT status FROM invitation_email WHERE invitation_id=$1",
          [result.id]
        )
        if (delivery.rows[0]?.status !== "sent")
          throw new APIError("SERVICE_UNAVAILABLE", {
            message:
              "The invitation was saved, but email delivery could not be confirmed. Use Resend invitation to try again.",
          })
      }),
    },
    // Recheck the current policy when links are redeemed, including existing accounts.
    databaseHooks: {
      user: {
        create: {
          before: async (user, ctx) => {
            if (
              ctx?.path === "/magic-link/verify" &&
              !isAllowedEmail(user.email)
            )
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_DOMAIN_NOT_ALLOWED",
                message: "Email sign-in is not available for this address.",
              })
          },
        },
      },
      session: {
        create: {
          before: async (session, ctx) => {
            if (ctx?.path !== "/magic-link/verify") return
            const user = await ctx.context.internalAdapter.findUserById(
              session.userId
            )
            if (!user || !isAllowedEmail(user.email))
              throw new APIError("FORBIDDEN", {
                code: "EMAIL_DOMAIN_NOT_ALLOWED",
                message: "Email sign-in is not available for this address.",
              })
          },
        },
      },
    },
    disabledPaths: ["/token"],
    socialProviders:
      process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
        ? {
            google: {
              clientId: process.env.GOOGLE_CLIENT_ID,
              clientSecret: process.env.GOOGLE_CLIENT_SECRET,
              // Refresh profiles created before Google supplied a name or photo.
              overrideUserInfoOnSignIn: true,
              // Gate the provider profile before account creation, linking, or login.
              getUserInfo: async (tokens) => {
                const profile = await google({
                  clientId: process.env.GOOGLE_CLIENT_ID!,
                  clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
                }).getUserInfo(tokens)
                return profile &&
                  (isAllowedGoogleUser(profile.user) ||
                    (await hasInvitationSignInAccess(database, profile.user)))
                  ? profile
                  : null
              },
            },
          }
        : {},
    session: { cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: "database" },
    plugins: [
      magicLink({
        expiresIn: signInLinkExpirySeconds,
        storeToken: "hashed",
        sendMagicLink: sendSignInLink,
      }),
      organization({
        ac,
        invitationExpiresIn: invitationLifetimeSeconds,
        requireEmailVerificationOnInvitation: true,
        sendInvitationEmail: (data) =>
          sendInvitationEmail(database, baseURL, data),
        organizationHooks: {
          async beforeUpdateOrganization({ organization }) {
            const result = organizationDetailsSchema
              .partial()
              .safeParse(organization)
            if (!result.success)
              throw new APIError("BAD_REQUEST", {
                message: result.error.issues[0].message,
              })
            return { data: result.data }
          },
          async beforeCreateInvitation({ invitation, organization }) {
            requireInvitationEmail()
            // Expired re-invites get a fresh link; keep the pending list current.
            await database.query(
              `UPDATE invitation SET status='canceled'
              WHERE "organizationId"=$1 AND email=$2 AND status='pending' AND "expiresAt"<=now()`,
              [organization.id, invitation.email]
            )
          },
          async beforeAcceptInvitation({ invitation, organization }) {
            if (
              !(await memberRole(
                database,
                invitation.inviterId,
                organization.id
              ))
            )
              throw new APIError("BAD_REQUEST", {
                message:
                  "This invitation is no longer available. Ask an organization admin for a new invitation.",
              })
          },
          async beforeDeleteOrganization({ organization }) {
            const billing = await database.query(
              "SELECT organization_id FROM organization_billing WHERE organization_id=$1",
              [organization.id]
            )
            if (billing.rowCount)
              throw new APIError("FORBIDDEN", {
                message:
                  "This organization has billing history. Cancel its subscription in Billing and contact the installation operator to archive it.",
              })
          },
        },
        roles: {
          owner: ac.newRole({
            ...ownerAc.statements,
            apiKey: ["create", "read", "update", "delete"],
          }),
          admin: ac.newRole({
            ...adminAc.statements,
            apiKey: ["create", "read", "update", "delete"],
          }),
          member: ac.newRole({ ...memberAc.statements, apiKey: [] }),
        },
      }),
      apiKey({
        // Match createKeySchema, including names generated by trace onboarding.
        maximumNameLength: 100,
        enableMetadata: true,
        references: "organization",
        defaultPrefix: "dtk_",
        enableSessionForAPIKeys: false,
        permissions: { defaultPermissions: { traces: ["write"] } },
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 1000 },
      }),
      jwt({ jwks: { keyPairConfig: { alg: "RS256" } } }),
      oauthProvider({
        loginPage: "/sign-in",
        consentPage: "/mcp/consent",
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          ...workspaceScopes,
        ],
        grantTypes: ["authorization_code", "refresh_token"],
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        clientPrivileges: () => false,
        resourcePrivileges: () => false,
        // Resource scopes and TTLs are code-owned; update existing installs too.
        // Merge preserves operator fields omitted below (e.g. disabled, signing).
        resourceSeedMode: "merge",
        resources: [
          {
            identifier: `${baseURL}/api/cli`,
            allowedScopes: [...workspaceScopes, "offline_access"],
            accessTokenTtl: 300,
          },
          {
            identifier: resource,
            allowedScopes: [...mcpScopes, "offline_access"],
            accessTokenTtl: 300,
          },
        ],
        clientRegistrationDefaultResources: [resource],
        clientRegistrationAllowedResources: [`${baseURL}/api/cli`],
        accessTokenExpiresIn: 300,
        postLogin: {
          page: "/mcp/connect",
          shouldRedirect: () => !selectedOAuthProject(),
          consentReferenceId: async ({ user, scopes }) => {
            const projectId = selectedOAuthProject()
            if (typeof projectId !== "string")
              throw new APIError("FORBIDDEN", { message: "Select a project." })
            await authorizeOAuthProject(database, user.id, projectId, scopes)
            return projectId
          },
        },
        customAccessTokenClaims: async ({ user, referenceId, scopes }) => {
          if (!user || !referenceId)
            throw new APIError("FORBIDDEN", {
              message: "Project membership required.",
            })
          const access = await authorizeOAuthProject(
            database,
            user.id,
            referenceId,
            scopes
          )
          return {
            organizationId: access.organizationId,
            projectId: referenceId,
          }
        },
      }),
      nextCookies(),
    ],
  } satisfies Parameters<typeof betterAuth>[0]
}

export function createOrganizationAuth(
  database: Pool,
  options?: { baseURL?: string; secret?: string }
) {
  return betterAuth(organizationAuthOptions(database, options))
}

export async function authorizeOAuthProject(
  database: Pool,
  userId: string,
  projectId: string,
  scopes: readonly string[]
) {
  const result = await database.query<{ organizationId: string; role: string }>(
    `
    SELECT p.organization_id AS "organizationId", m.role
    FROM project p JOIN member m ON m."organizationId" = p.organization_id AND m."userId" = $2
    WHERE p.id = $1`,
    [projectId, userId]
  )
  const access = result.rows[0]
  if (
    !access ||
    scopes.some(
      (scope) =>
        (workspaceScopes as readonly string[]).includes(scope) &&
        !(roleScopes(access.role) as readonly string[]).includes(scope)
    )
  ) {
    throw new APIError("FORBIDDEN", {
      message:
        "Your organization role does not grant the requested project permissions.",
    })
  }
  return access
}
