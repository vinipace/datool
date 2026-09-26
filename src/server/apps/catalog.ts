import { z } from "zod"
import { isDeepStrictEqual } from "node:util"
import { definitionSchema } from "@/src/lib/playground/contracts"
import {
  appConnectionSchema,
  type PublicAppConnection,
} from "@/src/lib/playground/connections"
import {
  currentProjectId,
  liveBridge,
  mutate,
  readState,
  type StoredConnection,
} from "@/src/server/playground/storage"
import {
  encryptProviderKey,
  decryptProviderKey,
} from "@/src/server/model-providers/secrets"
import { checkSchema } from "@/src/server/playground/schema"

export const appRegistrationSchema = definitionSchema.extend({
  connection: appConnectionSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
})
export function publicAppConnection(
  connection?: StoredConnection
): PublicAppConnection {
  if (!connection || connection.type === "bridge") return { type: "bridge" }
  return {
    type: "webhook",
    url: connection.url,
    method: connection.method,
    body: connection.body,
    timeoutMs: connection.timeoutMs,
    headerNames: connection.headerNames,
  }
}
export function createAppCatalog(storage = { readState, mutate }) {
  async function listApps() {
    const state = await storage.readState()
    return state.apps.map((app) => ({
      ...app,
      connection: publicAppConnection(state.connections?.[app.id]),
      online:
        state.connections?.[app.id]?.type === "webhook" ||
        !!liveBridge(state, app.id),
    }))
  }
  async function registerApps(input: unknown) {
    const apps = z.array(appRegistrationSchema).min(1).max(100).parse(input)
    if (new Set(apps.map((app) => app.id)).size !== apps.length)
      throw new Error("Duplicate app IDs")
    apps.forEach((app) => {
      if (app.inputSchema.type !== "object")
        throw new Error("Apps must declare an object input schema")
      checkSchema(app.inputSchema)
      checkSchema(app.outputSchema)
    })
    return storage.mutate((state) =>
      apps.map(({ connection, expectedRevision, ...definition }) => {
        state.connections ??= {}
        const previous = state.apps.find((app) => app.id === definition.id)
        const oldConnection = state.connections[definition.id] ?? {
          type: "bridge" as const,
        }
        if (
          expectedRevision !== undefined &&
          expectedRevision !== (previous?.revision ?? 0)
        )
          throw new Error(
            "App changed. Reload its configuration before saving."
          )
        if (
          previous &&
          connection?.type !== undefined &&
          connection.type !== oldConnection.type &&
          expectedRevision === undefined
        )
          throw new Error(
            "Changing a connection type requires expectedRevision."
          )
        let stored: StoredConnection = oldConnection
        if (connection?.type === "webhook") {
          const { headers, ...config } = connection
          let encryptedHeaders = oldConnection.encryptedHeaders
          if (headers !== undefined) {
            let same = false
            if (encryptedHeaders) {
              try {
                same = isDeepStrictEqual(
                  JSON.parse(
                    decryptProviderKey(
                      encryptedHeaders,
                      currentProjectId(),
                      `app:${definition.id}`
                    )
                  ),
                  headers
                )
              } catch {
                /* Replacement remains possible after a key rotation. */
              }
            }
            if (!same)
              encryptedHeaders = Object.keys(headers).length
                ? encryptProviderKey(
                    JSON.stringify(headers),
                    currentProjectId(),
                    `app:${definition.id}`
                  )
                : undefined
          }
          stored = {
            ...config,
            headerNames: headers
              ? Object.keys(headers)
              : oldConnection.type === "webhook"
                ? oldConnection.headerNames
                : [],
            ...(encryptedHeaders ? { encryptedHeaders } : {}),
          }
        } else if (connection) stored = connection
        const changed =
          !isDeepStrictEqual(
            previous && definitionSchema.parse(previous),
            definition
          ) || !isDeepStrictEqual(stored, oldConnection)
        const saved = {
          ...definition,
          revision: (previous?.revision ?? 0) + (changed ? 1 : 0),
        }
        state.apps = [...state.apps.filter((app) => app.id !== saved.id), saved]
        state.connections[saved.id] = stored
        return { ...saved, connection: publicAppConnection(stored) }
      })
    )
  }
  return { listApps, registerApps }
}
export const { listApps, registerApps } = createAppCatalog()
