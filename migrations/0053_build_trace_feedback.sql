-- Keep channel replies attached to the canonical runtime message, even after
-- another turn starts. Visitor-supplied trace ids are never used for feedback.
ALTER TABLE build_channel_message ADD COLUMN runtime_message_id text;
ALTER TABLE build_channel_message ADD CONSTRAINT build_channel_runtime_message_fk
  FOREIGN KEY (project_id, runtime_message_id)
  REFERENCES build_conversation_messages(project_id, id) ON DELETE SET NULL (runtime_message_id);

UPDATE build_channel_message m
SET runtime_message_id = t.output_message_id
FROM build_channel_job j, build_conversation_turns t
WHERE m.direction = 'outbound'
  AND split_part(m.idempotency_key, ':', 1) = 'reply'
  AND split_part(m.idempotency_key, ':', 2) = j.message_id
  AND j.kind = 'process_inbound'
  AND j.project_id = m.project_id AND j.connection_id = m.connection_id
  AND t.project_id = m.project_id AND t.conversation_id = m.conversation_id
  AND t.request_key = 'channel:' || j.id::text;

-- Customer feedback is a native, mutable score with retained provenance.
-- It does not fabricate an evaluator run or mutate imported score evidence.
ALTER TABLE scores ADD COLUMN feedback_key text;
CREATE UNIQUE INDEX scores_project_feedback_idx ON scores(project_id, feedback_key);
ALTER TABLE scores DROP CONSTRAINT scores_origin_check;
ALTER TABLE scores ADD CONSTRAINT scores_origin_check CHECK (
  (external_json IS NULL AND import_id IS NULL AND feedback_key IS NULL
    AND trace_id IS NOT NULL AND eval_result_id IS NOT NULL AND evaluator_id IS NOT NULL
    AND span_id IS NULL AND session_id IS NULL AND eval_run_id IS NULL)
  OR
  (external_json IS NOT NULL AND eval_result_id IS NULL AND evaluator_id IS NULL
    AND ((import_id IS NOT NULL AND feedback_key IS NULL)
      OR (import_id IS NULL AND feedback_key IS NOT NULL AND trace_id IS NOT NULL AND span_id IS NULL))
    AND num_nonnulls(trace_id, session_id, eval_run_id) = 1
    AND (span_id IS NULL OR trace_id IS NOT NULL))
);

-- Recover existing message ratings using only ledger identities. An old rating
-- with no message identity stays in the event history; never guess its turn.
WITH linked AS (
  SELECT e.*, m.id AS runtime_message_id, t.trace_id, c.channel AS runtime_channel
  FROM build_operation_events e
  JOIN build_conversation_messages m ON m.project_id=e.project_id
    AND m.conversation_id=e.conversation_id AND m.id=e.payload_json->>'messageId' AND m.role='assistant'
  JOIN build_conversation_turns t ON t.project_id=m.project_id AND t.id=m.turn_id AND t.conversation_id=m.conversation_id
  JOIN build_conversations c ON c.project_id=m.project_id AND c.id=m.conversation_id
  WHERE e.event_type IN ('low_feedback','message_received')
    AND e.payload_json->>'sentiment' IN ('positive','negative','unknown')
  UNION ALL
  SELECT e.*, r.id AS runtime_message_id, t.trace_id, c.channel AS runtime_channel
  FROM build_operation_events e
  JOIN build_channel_message m ON m.project_id=e.project_id
    AND m.conversation_id=e.conversation_id AND m.id=e.payload_json->>'messageId' AND m.direction='outbound'
  JOIN build_conversation_messages r ON r.project_id=m.project_id
    AND r.id=m.runtime_message_id AND r.conversation_id=m.conversation_id AND r.role='assistant'
  JOIN build_conversation_turns t ON t.project_id=r.project_id AND t.id=r.turn_id AND t.conversation_id=r.conversation_id
  JOIN build_conversations c ON c.project_id=m.project_id AND c.id=m.conversation_id
  WHERE e.event_type IN ('low_feedback','message_received')
    AND e.payload_json->>'sentiment' IN ('positive','negative','unknown')
), latest AS (
  SELECT DISTINCT ON (e.project_id,e.runtime_message_id) e.*,
    to_char(e.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS rated_at
  FROM linked e JOIN traces t ON t.project_id=e.project_id AND t.id=e.trace_id
  ORDER BY e.project_id,e.runtime_message_id,e.occurred_at DESC,e.id DESC
)
INSERT INTO scores(id,project_id,trace_id,feedback_key,name,value,status,created_at,external_json)
SELECT 'score_feedback:' || runtime_message_id,project_id,trace_id,'build-message:' || runtime_message_id,
  'Customer feedback',null,'ok',rated_at,
  jsonb_strip_nulls(jsonb_build_object(
    'name','Customer feedback','timestamp',rated_at,
    'target',jsonb_build_object('type','trace','id',trace_id),
    'data',jsonb_build_object('type','categorical','value',CASE payload_json->>'sentiment' WHEN 'positive' THEN 'Helpful' WHEN 'negative' THEN 'Not helpful' ELSE 'Unrated' END),
    'source',jsonb_build_object('provider','datool-build','instance','build','projectId',project_id,'id',runtime_message_id),
    'comment',payload_json->>'reason',
    'metadata',jsonb_build_object('source','customer-feedback','conversationId',conversation_id,'messageId',runtime_message_id,
      'channelMessageId',CASE WHEN payload_json->>'messageId'<>runtime_message_id THEN payload_json->>'messageId' END,
      'channel',runtime_channel,'feedbackEventId',id)
  ))
FROM latest;
