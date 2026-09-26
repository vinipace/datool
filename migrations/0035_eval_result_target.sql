-- Additive only. Historical target IDs are deliberately not backfilled here.
ALTER TABLE eval_results ADD COLUMN target_id text;
ALTER TABLE eval_results ADD CONSTRAINT eval_results_project_run_target_fk
 FOREIGN KEY(project_id,run_id,target_id)
 REFERENCES eval_run_targets(project_id,run_id,id) ON DELETE CASCADE;
CREATE INDEX eval_results_target_evaluator_idx ON eval_results(project_id,run_id,target_id,evaluator_id);
