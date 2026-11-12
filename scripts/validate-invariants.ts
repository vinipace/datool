/**
 * Validates the NOT VALID invariant constraints added by
 * migrations/0078_enforce_invariants.sql. Each VALIDATE runs in its own
 * transaction and holds only SHARE UPDATE EXCLUSIVE, so reads and writes
 * continue. Pre-existing violations are reported; pass --strict to fail.
 */
import { assertDatabaseConfiguration, db } from "../lib/db"

export const invariantConstraints = [
  ["traces", "traces_status_check"],
  ["spans", "spans_status_check"],
  ["eval_runs", "eval_runs_status_check"],
  ["eval_results", "eval_results_status_check"],
  ["scores", "scores_status_check"],
  ["evaluators", "evaluators_active_version_fk"],
  ["eval_run_evaluators", "eval_run_evaluators_evaluator_version_fk"],
  ["eval_results", "eval_results_evaluator_version_fk"],
  ["build_conversation_messages", "build_conversation_messages_same_turn_fk"],
  [
    "build_conversation_tool_calls",
    "build_conversation_tool_calls_same_turn_fk",
  ],
  [
    "build_conversation_budget_reservations",
    "build_budget_reservations_same_turn_fk",
  ],
  ["build_conversations", "build_conversations_ai_owner_check"],
  ["build_conversations", "build_conversations_handoff_owner_check"],
  ["build_knowledge_chunks", "build_knowledge_chunks_source_agent_fk"],
  ["build_campaign_deliveries", "build_campaign_deliveries_same_campaign_fk"],
  ["build_inbox_tickets", "build_inbox_tickets_conversation_fk"],
  ["build_action_revisions", "build_action_revisions_same_agent_fk"],
  ["build_procedure_revisions", "build_procedure_revisions_same_agent_fk"],
  ["build_widget_revisions", "build_widget_revisions_same_agent_fk"],
  ["build_agents", "build_agents_applied_not_ahead_check"],
  ["build_shopify_order_operations", "build_shopify_orders_session_project_fk"],
  [
    "build_shopify_message_identity",
    "build_shopify_message_identity_session_project_fk",
  ],
  ["execution_credit_operation", "execution_credit_operation_state_fields"],
  ["build_channel_job", "build_channel_job_project_id_message_id_fkey"],
  ["build_collected_data", "build_collected_data_project_id_contact_id_fkey"],
  [
    "build_collected_data",
    "build_collected_data_project_id_conversation_id_fkey",
  ],
  ["build_leads", "build_leads_project_id_contact_id_fkey"],
  ["build_leads", "build_leads_project_id_conversation_id_fkey"],
  ["build_inbox_tickets", "build_inbox_tickets_project_id_contact_id_fkey"],
  ["build_csat_surveys", "build_csat_surveys_project_id_contact_id_fkey"],
  ["build_csat_surveys", "build_csat_surveys_project_id_conversation_id_fkey"],
  ["build_csat_surveys", "build_csat_surveys_project_id_ticket_id_fkey"],
  ["build_campaigns", "build_campaigns_project_id_connection_id_fkey"],
  [
    "build_operation_events",
    "build_operation_events_project_id_conversation_id_fkey",
  ],
] as const

type Problem = { constraint: string; message: string }

export async function validateInvariants(): Promise<Problem[]> {
  const problems: Problem[] = []
  const pending = await db.query<{ table: string; constraint: string }>(
    `SELECT c.conrelid::regclass::text AS table, c.conname AS constraint
       FROM pg_constraint c
      WHERE NOT c.convalidated AND c.conname = ANY($1::text[])`,
    [invariantConstraints.map(([, name]) => name)]
  )
  for (const { table, constraint } of pending.rows) {
    const client = await db.connect()
    try {
      await client.query("BEGIN")
      await client.query("SET LOCAL lock_timeout = '5s'")
      await client.query(
        `ALTER TABLE ${client.escapeIdentifier(table)} VALIDATE CONSTRAINT ${client.escapeIdentifier(constraint)}`
      )
      await client.query("COMMIT")
      console.info(`Validated ${constraint}.`)
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {})
      const detail = error as { message?: string; detail?: string }
      problems.push({
        constraint,
        message: [detail.message, detail.detail].filter(Boolean).join(" "),
      })
    } finally {
      client.release()
    }
  }

  const index = await db.query(
    "SELECT 1 FROM pg_indexes WHERE indexname = 'eval_results_one_settled_per_target'"
  )
  if (!index.rowCount) {
    const duplicates = await db.query<{ count: string }>(
      `SELECT count(*) AS count FROM (
         SELECT 1 FROM eval_results
          WHERE target_id IS NOT NULL AND status <> 'error'
          GROUP BY project_id, run_id, target_id, evaluator_id
         HAVING count(*) > 1) duplicated`
    )
    problems.push({
      constraint: "eval_results_one_settled_per_target",
      message: `Index is missing; ${duplicates.rows[0]?.count ?? "?"} (run, target, evaluator) groups have more than one settled result. Remove the extra rows, then create the index from migration 0078.`,
    })
  }
  return problems
}

if (import.meta.main) {
  assertDatabaseConfiguration()
  const strict = process.argv.includes("--strict")
  try {
    const problems = await validateInvariants()
    for (const problem of problems)
      console.warn(
        `Invariant not yet enforced for existing rows: ${problem.constraint}. ${problem.message}`
      )
    if (!problems.length)
      console.info("All invariant constraints are validated.")
    if (strict && problems.length) process.exitCode = 1
  } finally {
    await db.end()
  }
}
