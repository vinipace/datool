ALTER TABLE datasets
  ADD COLUMN metadata_json text NOT NULL DEFAULT '{}',
  ADD COLUMN field_schemas_json text NOT NULL DEFAULT '{}';
