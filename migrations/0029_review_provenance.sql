ALTER TABLE review_scores DROP CONSTRAINT review_scores_source_check;
ALTER TABLE review_scores ADD CONSTRAINT review_scores_source_check CHECK (source IN ('human', 'mcp', 'api'));
ALTER TABLE review_scores ADD COLUMN provenance_json jsonb;
ALTER TABLE review_scores ADD COLUMN edited_by_json jsonb;
UPDATE review_scores s SET provenance_json=jsonb_build_object(
  'label', CASE WHEN s.source='human' THEN 'Human-reviewed' ELSE 'AI-labelled' END,
  'authType', CASE WHEN s.source='human' THEN 'session' ELSE 'oauth' END,
  'principal', CASE WHEN s.reviewer_id IS NOT NULL THEN jsonb_build_object('type','user','id',s.reviewer_id,
    'name',coalesce((SELECT u.name FROM "user" u WHERE u.id=s.reviewer_id),'Former member')) ELSE 'null'::jsonb END);
ALTER TABLE review_items ADD COLUMN notes_provenance_json jsonb;
ALTER TABLE review_items ADD COLUMN last_submission_json jsonb;
-- Legacy notes and annotations have no trustworthy authentication-source record.
-- Preserve their content and authors without claiming they were human verified.
UPDATE review_items SET notes_provenance_json='{"label":"Unknown provenance","authType":"unknown","principal":null}'::jsonb WHERE notes<>'';
UPDATE review_items i SET annotations_json=(SELECT jsonb_agg(a || jsonb_build_object('provenance',
  jsonb_build_object('label','Unknown provenance','authType','unknown','principal',null))) FROM jsonb_array_elements(i.annotations_json) a)
WHERE jsonb_array_length(annotations_json)>0;
