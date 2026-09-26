ALTER TABLE review_items
  ADD COLUMN annotations_json jsonb NOT NULL DEFAULT '[]'::jsonb
  CHECK (jsonb_typeof(annotations_json) = 'array' AND jsonb_array_length(annotations_json) <= 100);
