CREATE TABLE human_scores (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  config_json jsonb NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived boolean NOT NULL DEFAULT false,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id,id)
);
CREATE UNIQUE INDEX human_scores_name_idx ON human_scores(project_id,lower(name));
CREATE TABLE human_score_collections (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  archived boolean NOT NULL DEFAULT false,
  created_at text NOT NULL,
  updated_at text NOT NULL,
  UNIQUE (project_id,id)
);
CREATE UNIQUE INDEX human_score_collections_name_idx ON human_score_collections(project_id,lower(name));
CREATE TABLE human_score_collection_items (
  project_id text NOT NULL,
  collection_id text NOT NULL,
  human_score_id text NOT NULL,
  ordinal integer NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (project_id,collection_id,human_score_id),
  UNIQUE(project_id,collection_id,ordinal),
  FOREIGN KEY(project_id,collection_id) REFERENCES human_score_collections(project_id,id) ON DELETE CASCADE,
  FOREIGN KEY(project_id,human_score_id) REFERENCES human_scores(project_id,id) ON DELETE CASCADE
);
ALTER TABLE review_sessions ADD COLUMN collection_id text,
  ADD COLUMN collection_snapshot_json jsonb,
  ADD FOREIGN KEY(project_id,collection_id) REFERENCES human_score_collections(project_id,id) ON DELETE NO ACTION;
ALTER TABLE review_scores ADD COLUMN human_score_id text,
  ADD COLUMN definition_json jsonb,
  ADD COLUMN human_value jsonb,
  ALTER COLUMN value DROP NOT NULL,
  ADD FOREIGN KEY(project_id,human_score_id) REFERENCES human_scores(project_id,id) ON DELETE NO ACTION;

-- Import actual human/MCP ratings, preserving their numeric values and original scorer provenance.
DO $$
DECLARE criterion record; display_name text; suffix integer;
BEGIN
  FOR criterion IN SELECT DISTINCT ON (project_id,criterion_key) project_id,criterion_key,name,updated_at
    FROM review_scores ORDER BY project_id,criterion_key,updated_at DESC,id
  LOOP
    display_name := criterion.name;
    suffix := 1;
    WHILE EXISTS (SELECT 1 FROM human_scores WHERE project_id=criterion.project_id AND lower(name)=lower(display_name)) LOOP
      suffix := suffix + 1;
      display_name := left(criterion.name,100)||' ('||suffix||')';
    END LOOP;
    INSERT INTO human_scores(id,project_id,name,config_json,created_at,updated_at)
    VALUES ('human_'||md5(criterion.project_id||':'||criterion.criterion_key),criterion.project_id,display_name,
      jsonb_build_object('name',display_name,'description','Imported from existing review ratings.',
        'type','numeric','min',0,'max',1,'step',0.01),criterion.updated_at,criterion.updated_at);
  END LOOP;
END $$;
UPDATE review_scores s SET human_score_id=h.id,
  definition_json=h.config_json||jsonb_build_object('id',h.id,'revision',h.revision,'archived',h.archived,'createdAt',h.created_at,'updatedAt',h.updated_at),
  human_value=to_jsonb(s.value), criterion_key='human:'||h.id
FROM human_scores h WHERE h.id='human_'||md5(s.project_id||':'||s.criterion_key) AND h.project_id=s.project_id;
ALTER TABLE review_scores ALTER COLUMN human_score_id SET NOT NULL,
  ALTER COLUMN definition_json SET NOT NULL,
  ALTER COLUMN human_value SET NOT NULL;
