-- One durable transcription attempt per inbound message. A worker retry never
-- dispatches another paid request after an uncertain provider outcome.
CREATE TABLE build_channel_transcription (
  message_id text PRIMARY KEY,
  project_id text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('requested','completed','failed','uncertain')),
  transcript text,
  seconds double precision CHECK (seconds >= 0),
  provider_id text,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id,message_id) REFERENCES build_channel_message(project_id,id) ON DELETE CASCADE
);
CREATE INDEX build_channel_transcription_project ON build_channel_transcription(project_id);
