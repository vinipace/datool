-- Keep the helpdesk's bounded recent-conversation list efficient across statuses.
CREATE INDEX IF NOT EXISTS build_inbox_tickets_project_recent_idx
  ON build_inbox_tickets(project_id, updated_at DESC, id DESC);
