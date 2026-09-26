-- Integer nano-USD preserves sub-cent model and sandbox usage without floats.
CREATE TABLE execution_credit_period (
  id uuid PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  subscription_id text NOT NULL,
  invoice_id text NOT NULL UNIQUE,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL CHECK (period_end > period_start),
  plan text NOT NULL CHECK (plan IN ('core','pro')),
  allowance bigint NOT NULL CHECK (allowance > 0),
  spent bigint NOT NULL DEFAULT 0 CHECK (spent >= 0),
  reserved bigint NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  CHECK (spent + reserved <= allowance),
  UNIQUE(organization_id,subscription_id,period_start)
);
CREATE INDEX execution_credit_current_idx ON execution_credit_period(organization_id,period_end DESC);
CREATE TABLE execution_credit_operation (
  id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES execution_credit_period(id) ON DELETE CASCADE,
  -- Historical identity survives project deletion without blocking that action.
  project_id text NOT NULL,
  runtime text NOT NULL CHECK (runtime IN ('model','sandbox')),
  rate_version text NOT NULL,
  reserved bigint NOT NULL CHECK (reserved > 0),
  charged bigint CHECK (charged >= 0 AND charged <= reserved),
  state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','settled','released')),
  provider_id text,
  usage jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX execution_credit_project_idx ON execution_credit_operation(project_id,created_at DESC);
CREATE TABLE execution_credit_ledger (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES execution_credit_period(id) ON DELETE CASCADE,
  operation_id uuid REFERENCES execution_credit_operation(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK(kind IN ('grant','reserve','settle','release')),
  amount bigint NOT NULL CHECK(amount >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(operation_id,kind)
);

ALTER TABLE project_sandbox_settings DROP CONSTRAINT project_sandbox_settings_providers_check1;
ALTER TABLE project_sandbox_settings ADD CONSTRAINT project_sandbox_settings_supported_providers
  CHECK (providers - ARRAY['local','vercel','modal','datool']::text[] = '{}'::jsonb);
