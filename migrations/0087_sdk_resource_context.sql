-- Display ownership survives connection removal; it does not grant drive access.
ALTER TABLE build_drives ADD COLUMN sdk_context jsonb;
ALTER TABLE build_agent_schedules ADD COLUMN sdk_context jsonb;

UPDATE build_drives d SET sdk_context = jsonb_build_object(
  'agentId', c.agent_id, 'connectionId', c.id,
  'workspace', d.name, 'workspaceName', d.name
)
FROM build_sdk_sessions s JOIN build_channel_connection c
  ON c.project_id=s.project_id AND c.id=s.connection_id
WHERE d.project_id=s.project_id AND d.id=s.drive_id;

-- File-only SDK users may not have opened a conversation yet. Recover their
-- owner only when the original deterministic drive ID matches exactly.
WITH candidates AS (
  SELECT d.id, c.id AS connection_id, c.agent_id, d.name,
    encode(sha256(convert_to('[' || to_json('sdk-drive-v1'::text)::text || ',' ||
      to_json(d.project_id)::text || ',' || to_json(c.id::text)::text || ',' ||
      to_json(d.provider)::text || ',' || to_json(d.name)::text || ']', 'UTF8')), 'hex') AS digest
  FROM build_drives d JOIN build_channel_connection c ON c.project_id=d.project_id AND c.channel='api'
  WHERE d.sdk_context IS NULL AND d.description='React SDK application drive'
)
UPDATE build_drives d SET sdk_context=jsonb_build_object(
  'agentId', c.agent_id, 'connectionId', c.connection_id,
  'workspace', c.name, 'workspaceName', c.name
)
FROM candidates c
WHERE d.id=c.id AND d.id=(substr(c.digest,1,8)||'-'||substr(c.digest,9,4)||'-5'||substr(c.digest,14,3)||'-a'||substr(c.digest,18,3)||'-'||substr(c.digest,21,12))::uuid;

-- Retain the authenticated binding on the task itself, even if its session
-- is later removed. A missing binding must never become a global agent run.
UPDATE build_agent_schedules a SET sdk_context = jsonb_build_object(
  'connectionId', s.connection_id, 'conversationId', s.conversation_id,
  'scopeKey', s.scope_key, 'driveId', s.drive_id,
  'workspace', d.name, 'workspaceName', d.name
)
FROM build_sdk_tasks t JOIN build_sdk_sessions s
  ON s.project_id=t.project_id AND s.conversation_id=t.conversation_id
LEFT JOIN build_drives d ON d.project_id=s.project_id AND d.id=s.drive_id
WHERE a.project_id=t.project_id AND a.id=t.task_id;

UPDATE build_agent_schedule_runs r
SET snapshot_json = r.snapshot_json || jsonb_build_object('sdkContext', a.sdk_context)
FROM build_agent_schedules a
WHERE a.project_id=r.project_id AND a.id=r.task_id AND a.sdk_context IS NOT NULL;
