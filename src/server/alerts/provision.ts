import type { Pool, PoolClient } from "pg"

export const quoteIdentifier = (value: string) =>
  `"${value.replaceAll('"', '""')}"`

/** Administrator-only setup. Never run from a request or a worker. */
export async function provisionAlertReader(admin: Pool, readerUrl: string) {
  const url = new URL(readerUrl)
  const role = decodeURIComponent(url.username)
  const password = decodeURIComponent(url.password)
  if (!role || !password)
    throw new Error(
      "The alert reader URL must have its own username and password."
    )
  const client = await admin.connect()
  try {
    await client.query("BEGIN")
    const context = (
      await client.query(
        "SELECT current_user AS owner, current_schema() AS schema, current_database() AS database"
      )
    ).rows[0]
    if (
      role === context.owner ||
      decodeURIComponent(url.pathname.slice(1)) !== context.database
    )
      throw new Error("Use a separate reader login in the same database.")
    const existing = await client.query(
      "SELECT 1 FROM pg_roles WHERE rolname=$1",
      [role]
    )
    if (existing.rowCount)
      await assertRestrictedAlertRole(client, role, context.schema, false)
    else
      await client.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 8`
      )
    // PostgreSQL quotes both identifiers and the secret. No credentials in logs.
    const passwordSql = await client.query(
      "SELECT format('ALTER ROLE %I PASSWORD %L', $1::text, $2::text) AS sql",
      [role, password]
    )
    await client.query(
      `ALTER ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 8`
    )
    await client.query(passwordSql.rows[0].sql)
    for (const [key, value] of Object.entries({
      default_transaction_read_only: "on",
      statement_timeout: "1500ms",
      transaction_timeout: "2500ms",
      lock_timeout: "250ms",
      idle_in_transaction_session_timeout: "2500ms",
      work_mem: "4MB",
      temp_file_limit: "16MB",
    })) {
      const setting = await client.query(
        "SELECT format('ALTER ROLE %I SET %I = %L', $1::text,$2::text,$3::text) AS sql",
        [role, key, value]
      )
      await client.query(setting.rows[0].sql)
    }
    await client.query(
      `GRANT USAGE ON SCHEMA ${quoteIdentifier(context.schema)} TO ${quoteIdentifier(role)}`
    )
    await client.query(
      `GRANT SELECT ON ${quoteIdentifier(context.schema)}.alert_evaluation_logs TO ${quoteIdentifier(role)}`
    )
    await assertRestrictedAlertRole(client, role, context.schema)
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}

/** Reject accidentally privileged credentials, PUBLIC grants and role inheritance. */
export async function assertRestrictedAlertRole(
  client: PoolClient,
  role?: string,
  schema?: string,
  requireView = true
) {
  const result = await client.query<{ safe: boolean }>(
    `
    SELECT NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
      AND NOT EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid)
      AND NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND datdba=r.oid)
      AND NOT has_schema_privilege(r.oid,n.oid,'CREATE')
      AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relname='alert_evaluation_logs'
        AND (c.relowner=r.oid OR has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')))
      AND NOT EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=n.oid AND c.relkind IN ('r','p','v','m','f','S')
        AND c.relname <> 'alert_evaluation_logs' AND (
          c.relowner=r.oid OR CASE WHEN c.relkind='S' THEN has_sequence_privilege(r.oid,c.oid,'USAGE,SELECT,UPDATE')
          ELSE has_table_privilege(r.oid,c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END))
      AND NOT EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=n.oid AND p.prosecdef AND has_function_privilege(r.oid,p.oid,'EXECUTE'))
      AND (NOT $3::boolean OR has_table_privilege(r.oid,format('%I.alert_evaluation_logs',n.nspname),'SELECT'))
      AS safe FROM pg_roles r JOIN pg_namespace n ON n.nspname=coalesce($2,current_schema())
      WHERE r.rolname=coalesce($1,current_user)`,
    [role ?? null, schema ?? null, requireView]
  )
  if (!result.rows[0]?.safe)
    throw new Error(
      "Alert reader must be a restricted login with access only to the scoped alert view. Run db:alerts-reader with a new dedicated role."
    )
}
