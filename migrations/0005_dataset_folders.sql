CREATE TABLE dataset_folders (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  CONSTRAINT dataset_folders_project_name_idx UNIQUE (project_id, name)
);

-- Full dataset names remain resource keys. Index direct-child reads without
-- loading every dataset or inferring the hierarchy in the browser.
CREATE INDEX dataset_folders_parent_idx ON dataset_folders
  (project_id, (regexp_replace(name, '[^/]+$', '')), name, id);
CREATE INDEX datasets_parent_idx ON datasets
  (project_id, (regexp_replace(name, '[^/]+$', '')), name, id);

-- Preserve existing slash-separated dataset keys and make their parents real,
-- persistent folders (including after the last dataset is moved out).
INSERT INTO dataset_folders (id, project_id, name, created_at, updated_at)
SELECT 'df_' || md5(project_id || ':' || path), project_id, path,
  min(created_at), max(updated_at)
FROM (
  SELECT project_id, created_at, updated_at,
    array_to_string((string_to_array(name, '/'))[1:depth], '/') AS path
  FROM datasets
  CROSS JOIN LATERAL generate_series(1, array_length(string_to_array(name, '/'), 1) - 1) AS depth
) parents
WHERE path <> ''
GROUP BY project_id, path;
