-- Additive execution checkpoints. Existing evidence and judgments are retained.
ALTER TABLE eval_run_lease ADD COLUMN owner text;
ALTER TABLE eval_run_targets ADD COLUMN stage text NOT NULL DEFAULT 'legacy';
ALTER TABLE eval_run_targets ADD COLUMN progress_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE eval_run_targets ADD COLUMN execution_error text;

