CREATE TABLE invitation_email (
  invitation_id text PRIMARY KEY REFERENCES invitation(id) ON DELETE CASCADE,
  attempt_id uuid NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending','sent','failed')),
  provider_id text,
  attempted_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz
);
