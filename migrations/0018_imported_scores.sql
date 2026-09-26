-- External scores retain their own values and provenance without fake eval executions.
CREATE TABLE score_imports (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('imported', 'unsupported', 'unresolved')),
  reason text,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id, id)
);
CREATE INDEX score_imports_project_page_idx ON score_imports(project_id, created_at, id);

ALTER TABLE scores
  ALTER COLUMN trace_id DROP NOT NULL,
  ALTER COLUMN eval_result_id DROP NOT NULL,
  ALTER COLUMN evaluator_id DROP NOT NULL,
  ADD COLUMN span_id text,
  ADD COLUMN session_id text,
  ADD COLUMN eval_run_id text,
  ADD COLUMN import_id text,
  ADD COLUMN external_json jsonb,
  ADD CONSTRAINT scores_project_import_fk FOREIGN KEY (project_id, import_id) REFERENCES score_imports(project_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT scores_project_span_fk FOREIGN KEY (project_id, trace_id, span_id) REFERENCES spans(project_id, trace_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT scores_project_session_fk FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT scores_project_run_fk FOREIGN KEY (project_id, eval_run_id) REFERENCES eval_runs(project_id, id) ON DELETE CASCADE,
  ADD CONSTRAINT scores_origin_check CHECK (
    (external_json IS NULL AND import_id IS NULL AND trace_id IS NOT NULL AND eval_result_id IS NOT NULL AND evaluator_id IS NOT NULL AND span_id IS NULL AND session_id IS NULL AND eval_run_id IS NULL)
    OR
    (external_json IS NOT NULL AND import_id IS NOT NULL AND eval_result_id IS NULL AND evaluator_id IS NULL
      AND num_nonnulls(trace_id, session_id, eval_run_id) = 1 AND (span_id IS NULL OR trace_id IS NOT NULL))
  );
CREATE UNIQUE INDEX scores_project_import_idx ON scores(project_id, import_id);
