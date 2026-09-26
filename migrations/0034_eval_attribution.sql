-- Additive only: historical runs remain unresolved until an explicit backfill.
ALTER TABLE eval_runs ADD COLUMN groups_resolved_at text;
CREATE UNIQUE INDEX eval_targets_project_run_id_idx ON eval_run_targets(project_id,run_id,id);

CREATE TABLE eval_run_groups (
 id text PRIMARY KEY,
 project_id text NOT NULL,
 run_id text NOT NULL,
 group_type text NOT NULL CHECK(group_type IN ('agent','workflow')),
 group_name text NOT NULL,
 group_version text,
 FOREIGN KEY(project_id,run_id) REFERENCES eval_runs(project_id,id) ON DELETE CASCADE
);
CREATE INDEX eval_groups_run_idx ON eval_run_groups(project_id,run_id);
CREATE INDEX eval_groups_lookup_idx ON eval_run_groups(project_id,group_type,group_name,run_id);

-- Case-level facts prevent a mixed run from attributing every score to every group.
CREATE TABLE eval_target_attributions (
 id text PRIMARY KEY,
 project_id text NOT NULL,
 run_id text NOT NULL,
 target_id text NOT NULL,
 group_type text CHECK(group_type IN ('agent','workflow')),
 group_name text,
 group_version text,
 models_json jsonb NOT NULL DEFAULT '[]',
 source_trace_id text NOT NULL,
 source_span_id text,
 CHECK((group_type IS NULL) = (group_name IS NULL)),
 FOREIGN KEY(project_id,run_id,target_id) REFERENCES eval_run_targets(project_id,run_id,id) ON DELETE CASCADE
);
CREATE INDEX eval_attribution_target_idx ON eval_target_attributions(project_id,run_id,target_id);
CREATE INDEX eval_attribution_group_idx ON eval_target_attributions(project_id,group_type,group_name,run_id,target_id);
