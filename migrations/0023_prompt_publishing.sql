ALTER TABLE managed_prompts
  ADD COLUMN published_version integer,
  ADD COLUMN published_config_json text,
  ADD COLUMN published_at text;

-- Existing saves were already served to agents; preserve them as published.
UPDATE managed_prompts
SET published_version = revision,
    published_config_json = config_json,
    published_at = updated_at;

ALTER TABLE managed_prompts ADD CONSTRAINT managed_prompts_publication_check
  CHECK (
    (published_version IS NULL AND published_config_json IS NULL AND published_at IS NULL)
    OR
    (published_version IS NOT NULL AND published_version > 0
      AND published_config_json IS NOT NULL AND published_at IS NOT NULL)
  );
