CREATE INDEX alert_deliveries_alert_page_idx
  ON alert_deliveries(project_id, alert_id, created_at DESC, id DESC);
