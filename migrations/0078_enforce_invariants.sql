-- Enforce invariants the application already relies on.
--
-- Every new constraint is added NOT VALID: PostgreSQL checks all new and
-- updated rows immediately, but existing rows are not scanned while this
-- migration holds its locks. `bun run db:validate-invariants` (run by
-- scripts/release.sh) validates them afterwards in separate transactions and
-- reports any pre-existing violations without blocking the release.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1. Closed status vocabularies. Generated columns, summary triggers and
--    readers match these exact strings; an unknown value silently drops out of
--    durations, invocation summaries and dashboards.
ALTER TABLE traces ADD CONSTRAINT traces_status_check
  CHECK (status IN ('running','completed','errored','cancelled')) NOT VALID;
ALTER TABLE spans ADD CONSTRAINT spans_status_check
  CHECK (status IN ('running','completed','errored','cancelled')) NOT VALID;
ALTER TABLE eval_runs ADD CONSTRAINT eval_runs_status_check
  CHECK (status IN ('running','completed','partial','failed','cancelled')) NOT VALID;
ALTER TABLE eval_results ADD CONSTRAINT eval_results_status_check
  CHECK (status IN ('completed','passed','failed','error')) NOT VALID;
ALTER TABLE scores ADD CONSTRAINT scores_status_check
  CHECK (status IN ('ok','empty','error')) NOT VALID;

-- 2. An evaluator version belongs to the evaluator that references it.
ALTER TABLE evaluator_versions
  ADD CONSTRAINT evaluator_versions_project_evaluator_id_key UNIQUE (project_id, evaluator_id, id);
-- Evaluators are inserted before their first version in the same transaction.
ALTER TABLE evaluators ADD CONSTRAINT evaluators_active_version_fk
  FOREIGN KEY (project_id, id, active_version_id)
  REFERENCES evaluator_versions(project_id, evaluator_id, id)
  ON DELETE SET NULL (active_version_id)
  DEFERRABLE INITIALLY DEFERRED NOT VALID;
ALTER TABLE eval_run_evaluators ADD CONSTRAINT eval_run_evaluators_evaluator_version_fk
  FOREIGN KEY (project_id, evaluator_id, evaluator_version_id)
  REFERENCES evaluator_versions(project_id, evaluator_id, id) NOT VALID;
ALTER TABLE eval_results ADD CONSTRAINT eval_results_evaluator_version_fk
  FOREIGN KEY (project_id, evaluator_id, evaluator_version_id)
  REFERENCES evaluator_versions(project_id, evaluator_id, id) NOT VALID;

-- 3. One settled judgment per run target and evaluator. Error results are
--    replaced by retries; legacy rows without target_id are not covered.
--    If historical duplicates exist the index is skipped with a warning and
--    db:validate-invariants lists them; new writes are still checked by code.
DO $$ BEGIN
  CREATE UNIQUE INDEX eval_results_one_settled_per_target
    ON eval_results(project_id, run_id, target_id, evaluator_id)
    WHERE target_id IS NOT NULL AND status <> 'error';
EXCEPTION WHEN unique_violation THEN
  RAISE WARNING 'eval_results has duplicate settled results; eval_results_one_settled_per_target was not created. Run db:validate-invariants.';
END $$;

-- 4. Conversation children reference a turn of the same conversation.
ALTER TABLE build_conversation_turns
  ADD CONSTRAINT build_conversation_turns_conversation_id_key UNIQUE (project_id, conversation_id, id);
ALTER TABLE build_conversation_messages ADD CONSTRAINT build_conversation_messages_same_turn_fk
  FOREIGN KEY (project_id, conversation_id, turn_id)
  REFERENCES build_conversation_turns(project_id, conversation_id, id)
  ON DELETE SET NULL (turn_id) NOT VALID;
ALTER TABLE build_conversation_tool_calls ADD CONSTRAINT build_conversation_tool_calls_same_turn_fk
  FOREIGN KEY (project_id, conversation_id, turn_id)
  REFERENCES build_conversation_turns(project_id, conversation_id, id)
  ON DELETE CASCADE NOT VALID;
ALTER TABLE build_conversation_budget_reservations ADD CONSTRAINT build_budget_reservations_same_turn_fk
  FOREIGN KEY (project_id, conversation_id, turn_id)
  REFERENCES build_conversation_turns(project_id, conversation_id, id)
  ON DELETE CASCADE NOT VALID;

-- 4b. ON DELETE SET NULL on a composite (project_id, x) key nulls project_id
--     too, which is NOT NULL: deleting a single turn, contact, conversation,
--     ticket, channel message or connection failed whenever a dependent row
--     existed. Null only the reference column. The superseded message-to-turn
--     key is replaced by build_conversation_messages_same_turn_fk above.
ALTER TABLE build_conversation_messages DROP CONSTRAINT build_conversation_messages_project_id_turn_id_fkey;
ALTER TABLE build_channel_job DROP CONSTRAINT build_channel_job_project_id_message_id_fkey,
  ADD CONSTRAINT build_channel_job_project_id_message_id_fkey FOREIGN KEY (project_id, message_id)
  REFERENCES build_channel_message(project_id, id) ON DELETE SET NULL (message_id) NOT VALID;
ALTER TABLE build_collected_data DROP CONSTRAINT build_collected_data_project_id_contact_id_fkey,
  ADD CONSTRAINT build_collected_data_project_id_contact_id_fkey FOREIGN KEY (project_id, contact_id)
  REFERENCES build_contacts(project_id, id) ON DELETE SET NULL (contact_id) NOT VALID;
ALTER TABLE build_collected_data DROP CONSTRAINT build_collected_data_project_id_conversation_id_fkey,
  ADD CONSTRAINT build_collected_data_project_id_conversation_id_fkey FOREIGN KEY (project_id, conversation_id)
  REFERENCES build_conversations(project_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;
ALTER TABLE build_leads DROP CONSTRAINT build_leads_project_id_contact_id_fkey,
  ADD CONSTRAINT build_leads_project_id_contact_id_fkey FOREIGN KEY (project_id, contact_id)
  REFERENCES build_contacts(project_id, id) ON DELETE SET NULL (contact_id) NOT VALID;
ALTER TABLE build_leads DROP CONSTRAINT build_leads_project_id_conversation_id_fkey,
  ADD CONSTRAINT build_leads_project_id_conversation_id_fkey FOREIGN KEY (project_id, conversation_id)
  REFERENCES build_conversations(project_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;
ALTER TABLE build_inbox_tickets DROP CONSTRAINT build_inbox_tickets_project_id_contact_id_fkey,
  ADD CONSTRAINT build_inbox_tickets_project_id_contact_id_fkey FOREIGN KEY (project_id, contact_id)
  REFERENCES build_contacts(project_id, id) ON DELETE SET NULL (contact_id) NOT VALID;
ALTER TABLE build_csat_surveys DROP CONSTRAINT build_csat_surveys_project_id_contact_id_fkey,
  ADD CONSTRAINT build_csat_surveys_project_id_contact_id_fkey FOREIGN KEY (project_id, contact_id)
  REFERENCES build_contacts(project_id, id) ON DELETE SET NULL (contact_id) NOT VALID;
ALTER TABLE build_csat_surveys DROP CONSTRAINT build_csat_surveys_project_id_conversation_id_fkey,
  ADD CONSTRAINT build_csat_surveys_project_id_conversation_id_fkey FOREIGN KEY (project_id, conversation_id)
  REFERENCES build_conversations(project_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;
ALTER TABLE build_csat_surveys DROP CONSTRAINT build_csat_surveys_project_id_ticket_id_fkey,
  ADD CONSTRAINT build_csat_surveys_project_id_ticket_id_fkey FOREIGN KEY (project_id, ticket_id)
  REFERENCES build_inbox_tickets(project_id, id) ON DELETE SET NULL (ticket_id) NOT VALID;
ALTER TABLE build_campaigns DROP CONSTRAINT build_campaigns_project_id_connection_id_fkey,
  ADD CONSTRAINT build_campaigns_project_id_connection_id_fkey FOREIGN KEY (project_id, connection_id)
  REFERENCES build_channel_connection(project_id, id) ON DELETE SET NULL (connection_id) NOT VALID;
ALTER TABLE build_operation_events DROP CONSTRAINT build_operation_events_project_id_conversation_id_fkey,
  ADD CONSTRAINT build_operation_events_project_id_conversation_id_fkey FOREIGN KEY (project_id, conversation_id)
  REFERENCES build_conversations(project_id, id) ON DELETE SET NULL (conversation_id) NOT VALID;

-- 5. Ownership fields agree. An AI owner has no owner id, and a handed-off
--    conversation is owned by a human (a user, team or business app id).
ALTER TABLE build_conversations ADD CONSTRAINT build_conversations_ai_owner_check
  CHECK (owner_type = 'human' OR owner_id IS NULL) NOT VALID;
ALTER TABLE build_conversations ADD CONSTRAINT build_conversations_handoff_owner_check
  CHECK (status <> 'handed_off' OR owner_type = 'human') NOT VALID;

-- 6. Same-parent links that were only tenant-scoped.
ALTER TABLE build_knowledge_sources
  ADD CONSTRAINT build_knowledge_sources_project_agent_id_key UNIQUE (project_id, agent_id, id);
ALTER TABLE build_knowledge_chunks ADD CONSTRAINT build_knowledge_chunks_source_agent_fk
  FOREIGN KEY (project_id, agent_id, source_id)
  REFERENCES build_knowledge_sources(project_id, agent_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE build_campaign_audience
  ADD CONSTRAINT build_campaign_audience_campaign_id_key UNIQUE (project_id, campaign_id, id);
ALTER TABLE build_campaign_deliveries ADD CONSTRAINT build_campaign_deliveries_same_campaign_fk
  FOREIGN KEY (project_id, campaign_id, audience_id)
  REFERENCES build_campaign_audience(project_id, campaign_id, id) ON DELETE CASCADE NOT VALID;

ALTER TABLE build_inbox_tickets ADD CONSTRAINT build_inbox_tickets_conversation_fk
  FOREIGN KEY (project_id, conversation_id)
  REFERENCES build_conversations(project_id, id) ON DELETE CASCADE NOT VALID;

-- Definition revisions belong to the same agent as their definition.
ALTER TABLE build_actions ADD CONSTRAINT build_actions_project_id_agent_key UNIQUE (project_id, id, agent_id);
ALTER TABLE build_procedures ADD CONSTRAINT build_procedures_project_id_agent_key UNIQUE (project_id, id, agent_id);
ALTER TABLE build_widgets ADD CONSTRAINT build_widgets_project_id_agent_key UNIQUE (project_id, id, agent_id);
ALTER TABLE build_action_revisions ADD CONSTRAINT build_action_revisions_same_agent_fk
  FOREIGN KEY (project_id, action_id, agent_id)
  REFERENCES build_actions(project_id, id, agent_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE build_procedure_revisions ADD CONSTRAINT build_procedure_revisions_same_agent_fk
  FOREIGN KEY (project_id, procedure_id, agent_id)
  REFERENCES build_procedures(project_id, id, agent_id) ON DELETE CASCADE NOT VALID;
ALTER TABLE build_widget_revisions ADD CONSTRAINT build_widget_revisions_same_agent_fk
  FOREIGN KEY (project_id, widget_id, agent_id)
  REFERENCES build_widgets(project_id, id, agent_id) ON DELETE CASCADE NOT VALID;

-- An agent catalog may only pin revisions of that agent's own definitions.
-- The runtime filters by agent and would otherwise drop a foreign pin silently.
CREATE FUNCTION datool_catalog_pin_same_agent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE pinned_agent text; catalog_agent text;
BEGIN
  SELECT agent_id INTO catalog_agent FROM build_agent_catalog_snapshots
    WHERE project_id = NEW.project_id AND id = NEW.catalog_id;
  IF TG_TABLE_NAME = 'build_agent_catalog_actions' THEN
    SELECT agent_id INTO pinned_agent FROM build_action_revisions
      WHERE project_id = NEW.project_id AND action_id = NEW.action_id AND revision = NEW.revision;
  ELSIF TG_TABLE_NAME = 'build_agent_catalog_procedures' THEN
    SELECT agent_id INTO pinned_agent FROM build_procedure_revisions
      WHERE project_id = NEW.project_id AND procedure_id = NEW.procedure_id AND revision = NEW.revision;
  ELSE
    SELECT agent_id INTO pinned_agent FROM build_widget_revisions
      WHERE project_id = NEW.project_id AND widget_id = NEW.widget_id AND revision = NEW.revision;
  END IF;
  -- Missing parents are reported by the existing foreign keys.
  IF catalog_agent IS NOT NULL AND pinned_agent IS NOT NULL AND pinned_agent <> catalog_agent THEN
    RAISE EXCEPTION 'A catalog can only pin definitions of its own agent'
      USING ERRCODE = '23503', TABLE = TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER catalog_pin_same_agent BEFORE INSERT OR UPDATE ON build_agent_catalog_actions
  FOR EACH ROW EXECUTE FUNCTION datool_catalog_pin_same_agent();
CREATE TRIGGER catalog_pin_same_agent BEFORE INSERT OR UPDATE ON build_agent_catalog_procedures
  FOR EACH ROW EXECUTE FUNCTION datool_catalog_pin_same_agent();
CREATE TRIGGER catalog_pin_same_agent BEFORE INSERT OR UPDATE ON build_agent_catalog_widgets
  FOR EACH ROW EXECUTE FUNCTION datool_catalog_pin_same_agent();

ALTER TABLE build_agents ADD CONSTRAINT build_agents_applied_not_ahead_check
  CHECK (applied_revision <= current_revision) NOT VALID;

-- 7. Shopify browser sessions were referenced by bare id across tenants.
ALTER TABLE build_shopify_visitor_sessions
  ADD CONSTRAINT build_shopify_visitor_sessions_project_id_key UNIQUE (project_id, id);
ALTER TABLE build_shopify_order_operations ADD CONSTRAINT build_shopify_orders_session_project_fk
  FOREIGN KEY (project_id, browser_session_id)
  REFERENCES build_shopify_visitor_sessions(project_id, id)
  ON DELETE SET NULL (browser_session_id) NOT VALID;
ALTER TABLE build_shopify_message_identity ADD CONSTRAINT build_shopify_message_identity_session_project_fk
  FOREIGN KEY (project_id, browser_session_id)
  REFERENCES build_shopify_visitor_sessions(project_id, id) ON DELETE CASCADE NOT VALID;

-- 8. Credit operation state agrees with its settlement fields.
ALTER TABLE execution_credit_operation ADD CONSTRAINT execution_credit_operation_state_fields
  CHECK (
    (state = 'reserved' AND charged IS NULL AND settled_at IS NULL)
    OR (state = 'settled' AND charged > 0 AND settled_at IS NOT NULL)
    OR (state = 'released' AND charged = 0 AND settled_at IS NOT NULL)
  ) NOT VALID;

-- 9. Encrypted credentials are bound to one key. Releases record the key's
--    fingerprint and refuse to start with a different one (see
--    scripts/check-encryption-key.ts), because the v1 envelope has no key id.
CREATE TABLE secret_fingerprint (
  name text PRIMARY KEY,
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
