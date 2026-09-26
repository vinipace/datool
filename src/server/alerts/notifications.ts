import { sql } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import type { Pool } from "pg"
import { db } from "@/lib/db"
import type { AlertNotification } from "@/src/lib/alerts/contracts"
import { registerTracerProjectId } from "../tracer/db"
import * as schema from "../tracer/schema"
import {
  collectionSqlFilter,
  collectionSqlPage,
} from "../tracer/collection-sql"
import { asTracerError } from "../tracer/errors"
import { getAlert } from "./service"

export async function listAlertNotifications(
  projectId: string,
  alertId: string,
  options: {
    cursor?: string | null
    filter?: string
    limit?: number
    includeTotal?: boolean
  } = {},
  pool: Pool = db
) {
  await getAlert(projectId, alertId, pool)
  try {
    const filter = collectionSqlFilter("alertNotifications", options.filter, {
      id: { value: sql`id`, type: "string" },
      status: { value: sql`status`, type: "string" },
      action: { value: sql`action`, type: "string" },
      attempts: { value: sql`attempts`, type: "number" },
      matchCount: { value: sql`"matchCount"`, type: "number" },
      traceName: { value: sql`"traceName"`, type: "string" },
      lastError: { value: sql`"lastError"`, type: "string" },
      createdAt: { value: sql`"createdAt"`, type: "date" },
    })
    const database = registerTracerProjectId(
      drizzle({ client: pool, schema }),
      projectId
    )
    return await collectionSqlPage<AlertNotification>(
      database,
      sql`
      SELECT * FROM (
        SELECT id,alert_id AS "alertId",alert_name AS "alertName",action,status,attempts,
          last_error AS "lastError",created_at AS "createdAt",delivered_at AS "deliveredAt",payload,
          (payload->>'matchCount')::int AS "matchCount",payload->'log'->>'trace_id' AS "traceId",
          payload->'log'->>'name' AS "traceName"
        FROM alert_deliveries WHERE project_id=${projectId} AND alert_id=${alertId}
      ) notifications WHERE ${filter}`,
      options,
      "createdAt"
    )
  } catch (error) {
    throw asTracerError(error, "Unable to load alert notifications.")
  }
}
