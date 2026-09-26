-- Initial PostgreSQL schema for a fresh Datool installation.
-- Application tables, indexes, functions, and triggers are installed together.

-- Better Auth 1.7.3 core tables with the organization plugin, followed by
-- application data. Column names intentionally match Better Auth defaults.

CREATE TABLE IF NOT EXISTS "user" (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  image text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS session (
  id text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  token text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now(),
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "activeOrganizationId" text
);

CREATE INDEX IF NOT EXISTS session_user_id_idx ON session ("userId");

CREATE TABLE IF NOT EXISTS account (
  id text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  scope text,
  password text,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS account_user_id_idx ON account ("userId");

CREATE TABLE IF NOT EXISTS verification (
  id text PRIMARY KEY,
  identifier text NOT NULL,
  value text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "updatedAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS verification_identifier_idx ON verification (identifier);

CREATE TABLE IF NOT EXISTS organization (
  id text PRIMARY KEY,
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  logo text,
  metadata text,
  "createdAt" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS organization_slug_idx ON organization (slug);

CREATE TABLE IF NOT EXISTS member (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  "userId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member',
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE ("organizationId", "userId")
);

CREATE INDEX IF NOT EXISTS member_organization_id_idx ON member ("organizationId");
CREATE INDEX IF NOT EXISTS member_user_id_idx ON member ("userId");

CREATE TABLE IF NOT EXISTS invitation (
  id text PRIMARY KEY,
  "organizationId" text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text,
  status text NOT NULL DEFAULT 'pending',
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL DEFAULT now(),
  "inviterId" text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS invitation_organization_id_idx ON invitation ("organizationId");
CREATE INDEX IF NOT EXISTS invitation_email_idx ON invitation (email);

CREATE TABLE IF NOT EXISTS project (
  id text PRIMARY KEY,
  organization_id text NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, slug)
);

CREATE INDEX IF NOT EXISTS project_organization_id_idx ON project (organization_id);

CREATE TABLE IF NOT EXISTS project_record (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('trace', 'evaluation', 'prompt', 'dataset')),
  name text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id)
);

CREATE INDEX IF NOT EXISTS project_record_project_kind_idx ON project_record (project_id, kind);

-- PostgreSQL tracer storage. Every row is tenant-scoped by project_id. The
-- composite keys below make every parent link prove the same project boundary.

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text, attributes_json text NOT NULL DEFAULT '{}', created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS sessions_project_updated_at_idx ON sessions(project_id, updated_at);

CREATE TABLE IF NOT EXISTS traces (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  session_id text, name text NOT NULL, operation text NOT NULL, input_json text, output_json text,
  attributes_json jsonb NOT NULL DEFAULT '{}', status text NOT NULL, started_at text NOT NULL, ended_at text,
  started_at_ms double precision,
  ended_at_ms double precision,
  UNIQUE (project_id, id),
  CONSTRAINT traces_project_session_fk FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE SET NULL (session_id)
);
CREATE INDEX IF NOT EXISTS traces_project_session_id_idx ON traces(project_id, session_id);
CREATE INDEX IF NOT EXISTS traces_project_started_at_idx ON traces(project_id, started_at);

CREATE TABLE IF NOT EXISTS spans (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  trace_id text NOT NULL, parent_id text, name text NOT NULL, kind text NOT NULL, input_json text, output_json text,
  attributes_json jsonb NOT NULL DEFAULT '{}', status text NOT NULL, started_at text NOT NULL, ended_at text,
  started_at_ms double precision,
  ended_at_ms double precision,
  UNIQUE (project_id, id),
  UNIQUE (project_id, trace_id, id),
  CONSTRAINT spans_project_trace_fk FOREIGN KEY (project_id, trace_id) REFERENCES traces(project_id, id) ON DELETE CASCADE,
  CONSTRAINT spans_project_parent_fk FOREIGN KEY (project_id, trace_id, parent_id) REFERENCES spans(project_id, trace_id, id) ON DELETE SET NULL (parent_id)
);
CREATE INDEX IF NOT EXISTS spans_project_trace_id_idx ON spans(project_id, trace_id);
CREATE INDEX IF NOT EXISTS spans_project_parent_id_idx ON spans(project_id, parent_id);

CREATE TABLE IF NOT EXISTS datasets (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL, description text, created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE (project_id, id), UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS dataset_items (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  dataset_id text NOT NULL, input_json text NOT NULL, expected_output_json text, metadata_json text NOT NULL DEFAULT '{}',
  source_trace_id text, created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE (project_id, id),
  CONSTRAINT dataset_items_project_dataset_fk FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE CASCADE,
  CONSTRAINT dataset_items_project_trace_fk FOREIGN KEY (project_id, source_trace_id) REFERENCES traces(project_id, id) ON DELETE SET NULL (source_trace_id)
);
CREATE INDEX IF NOT EXISTS dataset_items_project_dataset_id_idx ON dataset_items(project_id, dataset_id);

CREATE TABLE IF NOT EXISTS evaluators (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL, description text, active_version_id text, created_at text NOT NULL, updated_at text NOT NULL,
  UNIQUE (project_id, id), UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS evaluator_versions (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  evaluator_id text NOT NULL, version integer NOT NULL, language text NOT NULL, code text NOT NULL, created_at text NOT NULL,
  config_json text,
  UNIQUE (project_id, id),
  CONSTRAINT evaluator_versions_project_evaluator_fk FOREIGN KEY (project_id, evaluator_id) REFERENCES evaluators(project_id, id) ON DELETE CASCADE,
  UNIQUE (project_id, evaluator_id, version)
);

CREATE TABLE IF NOT EXISTS eval_runs (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  metadata_json text NOT NULL DEFAULT '{}', name text, dataset_id text, status text NOT NULL, created_at text NOT NULL, completed_at text,
  UNIQUE (project_id, id),
  CONSTRAINT eval_runs_project_dataset_fk FOREIGN KEY (project_id, dataset_id) REFERENCES datasets(project_id, id) ON DELETE SET NULL (dataset_id)
);
CREATE INDEX IF NOT EXISTS eval_runs_project_created_at_idx ON eval_runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS eval_runs_project_status_idx ON eval_runs(project_id, status);

CREATE TABLE IF NOT EXISTS eval_run_evaluators (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  run_id text NOT NULL, evaluator_id text NOT NULL, evaluator_version_id text NOT NULL,
  UNIQUE (project_id, id),
  CONSTRAINT eval_run_evaluators_project_run_fk FOREIGN KEY (project_id, run_id) REFERENCES eval_runs(project_id, id) ON DELETE CASCADE,
  CONSTRAINT eval_run_evaluators_project_evaluator_fk FOREIGN KEY (project_id, evaluator_id) REFERENCES evaluators(project_id, id) ON DELETE NO ACTION,
  CONSTRAINT eval_run_evaluators_project_version_fk FOREIGN KEY (project_id, evaluator_version_id) REFERENCES evaluator_versions(project_id, id) ON DELETE NO ACTION,
  UNIQUE (project_id, run_id, evaluator_id)
);

CREATE TABLE IF NOT EXISTS eval_run_targets (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  run_id text NOT NULL, trace_id text NOT NULL, dataset_item_id text, ordinal integer NOT NULL, created_at text NOT NULL,
  snapshot_json text,
  UNIQUE (project_id, id),
  CONSTRAINT eval_run_targets_project_run_fk FOREIGN KEY (project_id, run_id) REFERENCES eval_runs(project_id, id) ON DELETE CASCADE,
  CONSTRAINT eval_run_targets_project_trace_fk FOREIGN KEY (project_id, trace_id) REFERENCES traces(project_id, id) ON DELETE NO ACTION,
  CONSTRAINT eval_run_targets_project_item_fk FOREIGN KEY (project_id, dataset_item_id) REFERENCES dataset_items(project_id, id) ON DELETE SET NULL (dataset_item_id),
  UNIQUE (project_id, run_id, ordinal)
);

CREATE TABLE IF NOT EXISTS eval_results (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  run_id text NOT NULL, trace_id text NOT NULL, dataset_item_id text, evaluator_id text NOT NULL, evaluator_version_id text NOT NULL,
  score double precision, passed boolean, status text NOT NULL, reasoning text, error text, metadata_json text NOT NULL DEFAULT '{}', created_at text NOT NULL, completed_at text,
  UNIQUE (project_id, id),
  CONSTRAINT eval_results_project_run_fk FOREIGN KEY (project_id, run_id) REFERENCES eval_runs(project_id, id) ON DELETE CASCADE,
  CONSTRAINT eval_results_project_trace_fk FOREIGN KEY (project_id, trace_id) REFERENCES traces(project_id, id) ON DELETE CASCADE,
  CONSTRAINT eval_results_project_item_fk FOREIGN KEY (project_id, dataset_item_id) REFERENCES dataset_items(project_id, id) ON DELETE SET NULL (dataset_item_id),
  CONSTRAINT eval_results_project_evaluator_fk FOREIGN KEY (project_id, evaluator_id) REFERENCES evaluators(project_id, id) ON DELETE NO ACTION,
  CONSTRAINT eval_results_project_version_fk FOREIGN KEY (project_id, evaluator_version_id) REFERENCES evaluator_versions(project_id, id) ON DELETE NO ACTION
);
CREATE INDEX IF NOT EXISTS eval_results_project_run_id_idx ON eval_results(project_id, run_id);

CREATE TABLE IF NOT EXISTS scores (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  trace_id text NOT NULL, eval_result_id text NOT NULL, evaluator_id text NOT NULL, name text NOT NULL, value double precision, status text NOT NULL, created_at text NOT NULL,
  UNIQUE (project_id, id),
  CONSTRAINT scores_project_trace_fk FOREIGN KEY (project_id, trace_id) REFERENCES traces(project_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_project_result_fk FOREIGN KEY (project_id, eval_result_id) REFERENCES eval_results(project_id, id) ON DELETE CASCADE,
  CONSTRAINT scores_project_evaluator_fk FOREIGN KEY (project_id, evaluator_id) REFERENCES evaluators(project_id, id) ON DELETE NO ACTION,
  UNIQUE (project_id, eval_result_id)
);

CREATE TABLE IF NOT EXISTS saved_views (
  id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name text NOT NULL, resource text NOT NULL, columns_json text NOT NULL, filters_json text NOT NULL DEFAULT '[]', sort_json text,
  created_at text NOT NULL, updated_at text NOT NULL, UNIQUE (project_id, id)
);
CREATE INDEX IF NOT EXISTS saved_views_project_resource_idx ON saved_views(project_id, resource);

-- Better Auth organization API keys and OAuth provider (generated from the installed plugin schema).
create table if not exists "apikey" ("id" text not null primary key, "configId" text not null, "name" text, "start" text, "referenceId" text not null, "prefix" text, "key" text not null, "refillInterval" integer, "refillAmount" integer, "lastRefillAt" timestamptz, "enabled" boolean, "rateLimitEnabled" boolean, "rateLimitTimeWindow" integer, "rateLimitMax" integer, "requestCount" integer, "remaining" integer, "lastRequest" timestamptz, "expiresAt" timestamptz, "createdAt" timestamptz not null, "updatedAt" timestamptz not null, "permissions" text, "metadata" text);

create table if not exists "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" timestamptz not null, "expiresAt" timestamptz, "alg" text, "crv" text);

create table if not exists "oauthClient" ("id" text not null primary key, "clientId" text not null unique, "clientSecret" text, "clientDiscoveryId" text, "disabled" boolean, "skipConsent" boolean, "enableEndSession" boolean, "subjectType" text, "scopes" jsonb, "clientCredentialsScopes" jsonb, "userId" text references "user" ("id") on delete cascade, "createdAt" timestamptz, "updatedAt" timestamptz, "name" text, "uri" text, "icon" text, "contacts" jsonb, "tos" text, "policy" text, "softwareId" text, "softwareVersion" text, "softwareStatement" text, "redirectUris" jsonb not null, "postLogoutRedirectUris" jsonb, "backchannelLogoutUri" text, "backchannelLogoutSessionRequired" boolean, "tokenEndpointAuthMethod" text, "applicationType" text, "jwks" text, "jwksUri" text, "grantTypes" jsonb, "responseTypes" jsonb, "requirePKCE" boolean, "dpopBoundAccessTokens" boolean, "referenceId" text, "metadata" jsonb);

create table if not exists "oauthResource" ("id" text not null primary key, "identifier" text not null unique, "name" text not null, "accessTokenTtl" integer, "refreshTokenTtl" integer, "signingAlgorithm" text, "signingKeyId" text, "allowedScopes" jsonb, "customClaims" jsonb, "dpopBoundAccessTokensRequired" boolean, "disabled" boolean, "createdAt" timestamptz, "updatedAt" timestamptz, "policyVersion" integer, "metadata" jsonb);

create table if not exists "oauthClientResource" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "resourceId" text not null references "oauthResource" ("identifier") on delete cascade, "metadata" jsonb, "createdAt" timestamptz);

create table if not exists "oauthRefreshToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text not null references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "rotatedAt" timestamptz, "rotationReplayResponse" text, "rotationReplayExpiresAt" timestamptz, "authTime" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table if not exists "oauthAccessToken" ("id" text not null primary key, "token" text not null unique, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "sessionId" text references "session" ("id") on delete set null, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "authorizationCodeId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "refreshId" text references "oauthRefreshToken" ("id") on delete cascade, "expiresAt" timestamptz not null, "createdAt" timestamptz not null, "revoked" timestamptz, "confirmation" jsonb, "scopes" jsonb not null);

create table if not exists "oauthConsent" ("id" text not null primary key, "clientId" text not null references "oauthClient" ("clientId") on delete cascade, "userId" text references "user" ("id") on delete cascade, "referenceId" text, "resources" jsonb, "requestedUserInfoClaims" jsonb, "scopes" jsonb not null, "createdAt" timestamptz not null, "updatedAt" timestamptz not null);

create table if not exists "oauthClientAssertion" ("id" text not null primary key, "expiresAt" timestamptz not null);

create table if not exists "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index if not exists "apikey_configId_idx" on "apikey" ("configId");

create index if not exists "apikey_referenceId_idx" on "apikey" ("referenceId");

create index if not exists "apikey_key_idx" on "apikey" ("key");

create index if not exists "oauthClient_userId_idx" on "oauthClient" ("userId");

create index if not exists "oauthClientResource_clientId_idx" on "oauthClientResource" ("clientId");

create index if not exists "oauthClientResource_resourceId_idx" on "oauthClientResource" ("resourceId");

create index if not exists "oauthRefreshToken_clientId_idx" on "oauthRefreshToken" ("clientId");

create index if not exists "oauthRefreshToken_sessionId_idx" on "oauthRefreshToken" ("sessionId");

create index if not exists "oauthRefreshToken_userId_idx" on "oauthRefreshToken" ("userId");

create index if not exists "oauthRefreshToken_authorizationCodeId_idx" on "oauthRefreshToken" ("authorizationCodeId");

create index if not exists "oauthAccessToken_clientId_idx" on "oauthAccessToken" ("clientId");

create index if not exists "oauthAccessToken_sessionId_idx" on "oauthAccessToken" ("sessionId");

create index if not exists "oauthAccessToken_userId_idx" on "oauthAccessToken" ("userId");

create index if not exists "oauthAccessToken_authorizationCodeId_idx" on "oauthAccessToken" ("authorizationCodeId");

create index if not exists "oauthAccessToken_refreshId_idx" on "oauthAccessToken" ("refreshId");

create index if not exists "oauthConsent_clientId_idx" on "oauthConsent" ("clientId");

create index if not exists "oauthConsent_userId_idx" on "oauthConsent" ("userId");

create unique index if not exists "oauthClientResource_clientId_resourceId_uidx" on "oauthClientResource" ("clientId", "resourceId");

-- The receipt and lifecycle mutation commit together; retained receipts make replay safe.
CREATE TABLE IF NOT EXISTS ingestion_receipts (
  project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  event_id uuid NOT NULL,
  digest text NOT NULL,
  result_json jsonb NOT NULL,
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, event_id)
);

-- Organization-owned keys are intentionally independent of their creator's lifecycle.
CREATE TABLE IF NOT EXISTS organization_key_policy (
  organization_id text PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
  creation_disabled boolean NOT NULL DEFAULT false
);

-- Revoking consent must also invalidate refresh tokens; otherwise a reconnect
-- could accidentally make an older grant usable again.
CREATE OR REPLACE FUNCTION revoke_datool_consent_tokens() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE "oauthRefreshToken" SET revoked = NOW()
    WHERE "clientId" = OLD."clientId" AND "userId" = OLD."userId"
      AND "referenceId" IS NOT DISTINCT FROM OLD."referenceId" AND revoked IS NULL;
  UPDATE "oauthAccessToken" SET revoked = NOW()
    WHERE "clientId" = OLD."clientId" AND "userId" = OLD."userId"
      AND "referenceId" IS NOT DISTINCT FROM OLD."referenceId" AND revoked IS NULL;
  RETURN OLD;
END;
$$;
CREATE TRIGGER datool_consent_revocation AFTER DELETE ON "oauthConsent"
  FOR EACH ROW EXECUTE FUNCTION revoke_datool_consent_tokens();

CREATE TABLE IF NOT EXISTS custom_views (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 name text NOT NULL, resource text NOT NULL, settings_json text NOT NULL, revision integer NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL
);
CREATE INDEX IF NOT EXISTS custom_views_resource_idx ON custom_views(project_id, resource);
CREATE TABLE IF NOT EXISTS scorers (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 slug text NOT NULL, config_json text NOT NULL, revision integer NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL, UNIQUE(project_id, slug)
);
CREATE TABLE IF NOT EXISTS dashboards (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 name text NOT NULL, config_json text NOT NULL, revision integer NOT NULL DEFAULT 1,
 created_at text NOT NULL, updated_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_fields (
 id text PRIMARY KEY, project_id text NOT NULL REFERENCES project(id) ON DELETE CASCADE,
 name text NOT NULL, name_key text NOT NULL, definition_json text NOT NULL, UNIQUE(project_id, name_key)
);

-- Keep original timestamp strings for API compatibility. Parse once on writes,
-- not once per fact on every dashboard query. Invalid values remain NULL.
CREATE OR REPLACE FUNCTION datool_timestamp_ms(value text) RETURNS double precision
LANGUAGE sql STABLE SET timezone = 'UTC' SET datestyle = 'ISO, MDY'
AS $$ SELECT CASE WHEN pg_input_is_valid(value, 'timestamp with time zone')
  THEN trunc(extract(epoch FROM value::timestamptz) * 1000)::double precision END $$;

CREATE OR REPLACE FUNCTION datool_sync_trace_instants() RETURNS trigger
LANGUAGE plpgsql AS $$ BEGIN
  NEW.started_at_ms := datool_timestamp_ms(NEW.started_at);
  NEW.ended_at_ms := datool_timestamp_ms(NEW.ended_at);
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER traces_sync_instants BEFORE INSERT OR UPDATE ON traces
FOR EACH ROW EXECUTE FUNCTION datool_sync_trace_instants();
CREATE OR REPLACE TRIGGER spans_sync_instants BEFORE INSERT OR UPDATE ON spans
FOR EACH ROW EXECUTE FUNCTION datool_sync_trace_instants();

CREATE INDEX IF NOT EXISTS traces_project_started_ms_idx ON traces(project_id, started_at_ms);
CREATE INDEX IF NOT EXISTS spans_project_started_ms_idx ON spans(project_id, started_at_ms);
CREATE INDEX IF NOT EXISTS traces_project_page_idx ON traces(project_id, started_at, id);
CREATE INDEX IF NOT EXISTS traces_project_session_page_idx ON traces(project_id, session_id, started_at, id);
