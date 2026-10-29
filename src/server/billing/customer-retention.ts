import { db } from "@/lib/db"
import { billingEnabled } from "./config"

/** Cloud customer-service expiry. One bounded, serializable transaction keeps
 * a returning customer or newly opened support case from racing deletion.
 * Foreign-key cascades own messages, turns, actions, media and channel links. */
export async function expireCloudCustomerData(batchSize = 100) {
  if (!billingEnabled()) return { conversations: 0, contacts: 0 }
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000)
    throw new Error("Retention batches must contain 1–1000 records.")
  const client = await db.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE")
    await client.query("SET LOCAL statement_timeout='15s'")
    await client.query("SET LOCAL lock_timeout='2s'")
    const expired = await client.query<{ id: string }>(
      `
      SELECT c.id FROM build_conversations c
      JOIN project p ON p.id=c.project_id
      JOIN organization_billing b ON b.organization_id=p.organization_id
      WHERE (b.customer_id IS NOT NULL OR b.provider='shopify')
        AND greatest(c.created_at,c.updated_at,c.last_message_at) < now()-interval '365 days'
        AND c.status<>'handed_off' AND c.owner_type='ai'
        AND NOT EXISTS (SELECT 1 FROM build_inbox_tickets t WHERE t.project_id=c.project_id AND t.conversation_id=c.id
          AND (t.status NOT IN ('solved','closed') OR t.updated_at >= now()-interval '365 days'))
        AND NOT EXISTS (SELECT 1 FROM build_conversation_turns t WHERE t.conversation_id=c.id AND t.status NOT IN ('completed','failed','cancelled'))
        AND NOT EXISTS (SELECT 1 FROM build_conversation_tool_calls t WHERE t.conversation_id=c.id AND t.status NOT IN ('completed','failed'))
        AND NOT EXISTS (SELECT 1 FROM build_conversation_budget_reservations r WHERE r.conversation_id=c.id AND r.status IN ('reserved','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM build_usage_event u WHERE u.conversation_id=c.id AND u.status IN ('pending','uncertain'))
        AND NOT EXISTS (SELECT 1 FROM build_shopify_order_operations o WHERE o.conversation_id=c.id
          AND (o.status NOT IN ('placed','failed','return_processed') OR o.reconcile_after IS NOT NULL))
        AND NOT EXISTS (SELECT 1 FROM build_channel_message m WHERE m.conversation_id=c.id
          AND (m.status IN ('accepted','queued','sending','uncertain') OR m.updated_at >= now()-interval '365 days'))
        AND NOT EXISTS (SELECT 1 FROM build_channel_job j WHERE j.project_id=c.project_id AND j.status IN ('queued','running','uncertain') AND (
          j.payload_json->>'conversationId'=c.id OR
          j.payload_json->>'operationId' IN (SELECT id::text FROM build_shopify_order_operations WHERE conversation_id=c.id) OR
          j.message_id IN (SELECT id FROM build_channel_message WHERE conversation_id=c.id)))
        AND NOT EXISTS (SELECT 1 FROM inbox_mobile_events e WHERE e.conversation_id=c.id AND
          (e.expanded_at IS NULL OR EXISTS (SELECT 1 FROM inbox_mobile_push_jobs j WHERE j.event_id=e.id AND j.status IN ('pending','sending','receipt'))))
        AND NOT EXISTS (SELECT 1 FROM build_collected_data d WHERE d.conversation_id=c.id AND d.created_at>=now()-interval '365 days')
        AND NOT EXISTS (SELECT 1 FROM build_leads l WHERE l.conversation_id=c.id AND l.updated_at>=now()-interval '365 days')
        AND NOT EXISTS (SELECT 1 FROM build_csat_surveys s WHERE s.conversation_id=c.id AND greatest(s.requested_at,s.responded_at)>=now()-interval '365 days')
        AND NOT EXISTS (SELECT 1 FROM build_operation_events e WHERE e.conversation_id=c.id AND e.occurred_at>=now()-interval '365 days')
        AND NOT EXISTS (SELECT 1 FROM build_conversation_turns t WHERE t.conversation_id=c.id AND (
          EXISTS (SELECT 1 FROM eval_run_targets e WHERE e.project_id=t.project_id AND e.trace_id=t.trace_id) OR
          EXISTS (SELECT 1 FROM review_items r WHERE r.project_id=t.project_id AND r.trace_id=t.trace_id) OR
          EXISTS (SELECT 1 FROM dataset_items d WHERE d.project_id=t.project_id AND d.source_trace_id=t.trace_id)))
      ORDER BY c.updated_at,c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
      [batchSize]
    )
    const ids = expired.rows.map((row) => row.id)
    // These copies intentionally lack a cascading conversation foreign key.
    await client.query(
      `DELETE FROM build_channel_job j WHERE EXISTS (
        SELECT 1 FROM build_conversations c WHERE c.id=ANY($1::text[]) AND c.project_id=j.project_id AND (
          j.payload_json->>'conversationId'=c.id OR
          j.message_id IN (SELECT id FROM build_channel_message WHERE conversation_id=c.id) OR
          j.payload_json->>'operationId' IN (SELECT id::text FROM build_shopify_order_operations WHERE conversation_id=c.id)))`,
      [ids]
    )
    await client.query(
      `DELETE FROM build_whatsapp_receipt WHERE message_id IN
      (SELECT id FROM build_channel_message WHERE conversation_id=ANY($1::text[]))`,
      [ids]
    )
    await client.query(
      `DELETE FROM build_knowledge_gap_suggestions g WHERE EXISTS (
      SELECT 1 FROM build_operation_events e WHERE e.conversation_id=ANY($1::text[])
      AND g.project_id=e.project_id AND g.sample_event_ids ? e.id)`,
      [ids]
    )
    for (const table of [
      "build_collected_data",
      "build_leads",
      "build_csat_surveys",
      "build_operation_events",
      "build_inbox_tickets",
    ])
      await client.query(
        `DELETE FROM ${table} d USING build_conversations c
         WHERE c.id=ANY($1::text[]) AND d.conversation_id=c.id AND d.project_id=c.project_id`,
        [ids]
      )
    await client.query(
      "DELETE FROM build_conversations WHERE id=ANY($1::text[])",
      [ids]
    )

    const contacts = await client.query<{ id: string }>(
      `
      SELECT c.id FROM build_contacts c
      JOIN project p ON p.id=c.project_id
      JOIN organization_billing b ON b.organization_id=p.organization_id
      WHERE (b.customer_id IS NOT NULL OR b.provider='shopify')
        AND greatest(c.created_at,c.updated_at,c.last_seen_at)<now()-interval '365 days'
        AND c.status<>'blocked'
        AND NOT EXISTS (SELECT 1 FROM build_conversations v WHERE v.project_id=c.project_id AND v.metadata_json->>'contactId'=c.id)
        AND NOT EXISTS (SELECT 1 FROM build_channel_message m WHERE m.contact_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM build_inbox_tickets t WHERE t.contact_id=c.id)
        AND NOT EXISTS (SELECT 1 FROM build_campaign_suppressions s WHERE s.contact_id=c.id AND (s.expires_at IS NULL OR s.expires_at>now()))
        AND NOT EXISTS (SELECT 1 FROM build_campaign_audience a JOIN build_campaigns k ON k.id=a.campaign_id
          WHERE a.contact_id=c.id AND k.status NOT IN ('completed','failed'))
        AND NOT EXISTS (SELECT 1 FROM build_collected_data d WHERE d.contact_id=c.id AND (d.conversation_id IS NOT NULL OR d.created_at>=now()-interval '365 days'))
        AND NOT EXISTS (SELECT 1 FROM build_leads l WHERE l.contact_id=c.id AND (l.conversation_id IS NOT NULL OR l.updated_at>=now()-interval '365 days'))
        AND NOT EXISTS (SELECT 1 FROM build_csat_surveys s WHERE s.contact_id=c.id AND (s.conversation_id IS NOT NULL OR s.requested_at>=now()-interval '365 days'))
      ORDER BY c.updated_at,c.id LIMIT $1 FOR UPDATE OF c SKIP LOCKED`,
      [batchSize]
    )
    const contactIds = contacts.rows.map((row) => row.id)
    await client.query(
      `DELETE FROM build_knowledge_gap_suggestions g WHERE EXISTS (
      SELECT 1 FROM build_operation_events e WHERE e.contact_id=ANY($1::text[])
      AND g.project_id=e.project_id AND g.sample_event_ids ? e.id)`,
      [contactIds]
    )
    for (const table of [
      "build_collected_data",
      "build_leads",
      "build_csat_surveys",
      "build_operation_events",
    ])
      await client.query(
        `DELETE FROM ${table} d USING build_contacts c
         WHERE c.id=ANY($1::text[]) AND d.contact_id=c.id AND d.project_id=c.project_id`,
        [contactIds]
      )
    await client.query("DELETE FROM build_contacts WHERE id=ANY($1::text[])", [
      contactIds,
    ])
    await client.query("COMMIT")
    return { conversations: ids.length, contacts: contactIds.length }
  } catch (error) {
    await client.query("ROLLBACK")
    throw error
  } finally {
    client.release()
  }
}
