-- Teams are organization-wide user groups. Keep IDs and existing assignments.
ALTER TABLE build_teams ADD COLUMN organization_id text REFERENCES organization(id) ON DELETE CASCADE;
UPDATE build_teams t SET organization_id=p.organization_id FROM project p WHERE p.id=t.project_id;
ALTER TABLE build_teams ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE build_team_members ADD COLUMN organization_id text;
UPDATE build_team_members m SET organization_id=t.organization_id FROM build_teams t WHERE t.id=m.team_id;
ALTER TABLE build_team_members ALTER COLUMN organization_id SET NOT NULL;

ALTER TABLE build_team_members DROP CONSTRAINT build_team_members_project_id_team_id_fkey;
ALTER TABLE build_routing_rules DROP CONSTRAINT build_routing_rules_project_id_team_id_fkey;
ALTER TABLE build_inbox_tickets DROP CONSTRAINT build_inbox_tickets_project_id_team_id_fkey;
ALTER TABLE build_conversation_ownership DROP CONSTRAINT build_conversation_ownership_project_id_team_id_fkey;

-- Different projects may have used the same name. Preserve each group's identity
-- and membership instead of silently merging groups with different operators.
WITH duplicate_names AS (
  SELECT id, row_number() OVER (PARTITION BY organization_id, lower(name) ORDER BY created_at,id) AS ordinal
  FROM build_teams
)
UPDATE build_teams t SET name=left(t.name,100) || ' (' || t.id || ')'
FROM duplicate_names d WHERE d.id=t.id AND d.ordinal>1;

ALTER TABLE build_team_members DROP COLUMN project_id;
ALTER TABLE build_teams DROP COLUMN project_id;
ALTER TABLE build_teams ADD UNIQUE (organization_id,id);
CREATE UNIQUE INDEX build_teams_organization_name_idx ON build_teams(organization_id,lower(name));
ALTER TABLE build_team_members ADD PRIMARY KEY (organization_id,team_id,user_id);
ALTER TABLE build_team_members ADD FOREIGN KEY (organization_id,team_id) REFERENCES build_teams(organization_id,id) ON DELETE CASCADE;
CREATE INDEX build_team_members_available_idx ON build_team_members(organization_id,team_id,availability,updated_at);
ALTER TABLE build_routing_rules ADD FOREIGN KEY (team_id) REFERENCES build_teams(id) ON DELETE SET NULL;
ALTER TABLE build_inbox_tickets ADD FOREIGN KEY (team_id) REFERENCES build_teams(id) ON DELETE SET NULL;
ALTER TABLE build_conversation_ownership ADD FOREIGN KEY (team_id) REFERENCES build_teams(id) ON DELETE SET NULL;

-- Retain the old composite foreign key's tenant isolation while allowing a
-- team's assignments to span projects belonging to the same organization.
CREATE FUNCTION build_check_team_organization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM build_teams t JOIN project p ON p.organization_id=t.organization_id
    WHERE t.id=NEW.team_id AND p.id=NEW.project_id
  ) THEN
    RAISE EXCEPTION 'Team must belong to the project organization' USING ERRCODE='23503';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER build_ticket_team_organization BEFORE INSERT OR UPDATE OF team_id,project_id ON build_inbox_tickets FOR EACH ROW EXECUTE FUNCTION build_check_team_organization();
CREATE TRIGGER build_routing_team_organization BEFORE INSERT OR UPDATE OF team_id,project_id ON build_routing_rules FOR EACH ROW EXECUTE FUNCTION build_check_team_organization();
CREATE TRIGGER build_ownership_team_organization BEFORE INSERT OR UPDATE OF team_id,project_id ON build_conversation_ownership FOR EACH ROW EXECUTE FUNCTION build_check_team_organization();
