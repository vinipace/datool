import { dataDirectory, workspaceIdentity } from "@/src/server/auth/context"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { Pool, PoolClient } from "pg"
import { db } from "@/lib/db"
import type {
  AppDefinition,
  Attempt,
  Playground,
} from "@/src/lib/playground/contracts"
import type { PublicAppConnection } from "@/src/lib/playground/connections"

export type Bridge = {
  protocolVersion?: 2
  id: string
  appIds: string[]
  revisions: Record<string, number>
  transport?: "relay"
  url: string
  token: string
  expiresAt: number
  exchangeSequence?: number
  definitionHashes?: Record<string, string>
}
export type StoredConnection = PublicAppConnection & {
  encryptedHeaders?: string
}
export type State = {
  apps: AppDefinition[]
  connections?: Record<string, StoredConnection>
  bridges: Bridge[]
  playgrounds: Playground[]
  attempts: Attempt[]
}
export function currentProjectId() {
  const projectId = workspaceIdentity()?.projectId
  if (!projectId) throw new Error("Project context is required.")
  return projectId
}
async function initialState(): Promise<State> {
  try {
    const state = JSON.parse(
      await readFile(join(dataDirectory(), "playgrounds.json"), "utf8")
    ) as State
    return { ...state, bridges: [] }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return {
      apps: [],
      connections: {},
      bridges: [],
      playgrounds: [],
      attempts: [],
    }
  }
}
/** The row lock serializes writers across processes and server instances. */
export function createPlaygroundStorage(pool: Pool, seed = initialState) {
  async function ensure(projectId: string) {
    const found = await pool.query(
      "SELECT 1 FROM playground_state WHERE project_id=$1",
      [projectId]
    )
    if (!found.rowCount)
      await pool.query(
        "INSERT INTO playground_state(project_id,state) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [projectId, JSON.stringify(await seed())]
      )
  }
  return {
    async readState(): Promise<State> {
      const projectId = currentProjectId()
      await ensure(projectId)
      const result = await pool.query<{ state: State }>(
        "SELECT state FROM playground_state WHERE project_id=$1",
        [projectId]
      )
      return result.rows[0].state
    },
    async mutate<T>(
      action: (state: State, client: PoolClient) => T | Promise<T>
    ): Promise<T> {
      const projectId = currentProjectId()
      await ensure(projectId)
      const client = await pool.connect()
      try {
        await client.query("BEGIN")
        const result = await client.query<{ state: State }>(
          "SELECT state FROM playground_state WHERE project_id=$1 FOR UPDATE",
          [projectId]
        )
        const state = result.rows[0].state
        const value = await action(state, client)
        await client.query(
          "UPDATE playground_state SET state=$2,updated_at=now() WHERE project_id=$1",
          [projectId, JSON.stringify(state)]
        )
        await client.query("COMMIT")
        return value
      } catch (error) {
        await client.query("ROLLBACK")
        throw error
      } finally {
        client.release()
      }
    },
  }
}
export const { readState, mutate } = createPlaygroundStorage(db)
export function liveBridge(state: State, appId: string) {
  const app = state.apps.find((a) => a.id === appId)
  return state.bridges.find(
    (b) =>
      b.appIds.includes(appId) &&
      b.expiresAt > Date.now() &&
      b.revisions[appId] === app?.revision
  )
}
