ALTER TABLE review_sessions
  ADD COLUMN default_object_view_id text REFERENCES react_views(id) ON DELETE SET NULL;

-- NULL keeps collection criteria; an array overrides only this review item.
ALTER TABLE review_items ADD COLUMN criteria_snapshot_json jsonb
  CHECK (criteria_snapshot_json IS NULL OR jsonb_typeof(criteria_snapshot_json) = 'array');
