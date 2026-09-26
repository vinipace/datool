-- Additive: legacy content_json snapshots remain readable and are never rewritten.
ALTER TABLE dataset_snapshots ADD CONSTRAINT dataset_snapshots_project_id_unique UNIQUE(project_id, id);
CREATE TABLE dataset_snapshot_items (
  project_id text NOT NULL,
  snapshot_id text NOT NULL,
  id text NOT NULL,
  content_json jsonb NOT NULL,
  PRIMARY KEY(project_id, snapshot_id, id),
  FOREIGN KEY(project_id, snapshot_id) REFERENCES dataset_snapshots(project_id, id) ON DELETE CASCADE
);
