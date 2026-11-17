-- AI Business Runtime: durable asset registry (PostgreSQL 15+)
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS assets (
  id text PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('a2ui','a2api','a2wf','app')),
  name text NOT NULL,
  owner_tenant_id text,
  visibility text NOT NULL CHECK (visibility IN ('system','tenant','private')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (visibility = 'system' OR owner_tenant_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS asset_versions (
  asset_id text NOT NULL REFERENCES assets(id),
  version text NOT NULL,
  schema_version text NOT NULL,
  status text NOT NULL CHECK (status IN ('draft','validated','testing','published','deprecated')),
  content jsonb NOT NULL,
  content_hash char(64) NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  PRIMARY KEY (asset_id, version),
  CHECK ((status = 'published') = (published_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS asset_versions_status_idx ON asset_versions(status, asset_id);
CREATE INDEX IF NOT EXISTS asset_versions_content_gin_idx ON asset_versions USING gin(content);

CREATE TABLE IF NOT EXISTS asset_dependencies (
  asset_id text NOT NULL,
  asset_version text NOT NULL,
  dependency_id text NOT NULL,
  dependency_version text NOT NULL,
  dependency_kind text NOT NULL CHECK (dependency_kind IN ('a2ui','a2api','a2wf','app')),
  PRIMARY KEY (asset_id, asset_version, dependency_id, dependency_version),
  FOREIGN KEY (asset_id, asset_version) REFERENCES asset_versions(asset_id, version),
  FOREIGN KEY (dependency_id, dependency_version) REFERENCES asset_versions(asset_id, version)
);

CREATE TABLE IF NOT EXISTS asset_test_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id text NOT NULL,
  asset_version text NOT NULL,
  suite text NOT NULL,
  status text NOT NULL CHECK (status IN ('passed','failed','cancelled')),
  passed integer NOT NULL DEFAULT 0 CHECK (passed >= 0),
  failed integer NOT NULL DEFAULT 0 CHECK (failed >= 0),
  report jsonb NOT NULL DEFAULT '{}'::jsonb,
  runner text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  FOREIGN KEY (asset_id, asset_version) REFERENCES asset_versions(asset_id, version),
  CHECK (failed = 0 OR status <> 'passed')
);

CREATE TABLE IF NOT EXISTS publish_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id text NOT NULL,
  asset_version text NOT NULL,
  reviewer_id text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text,
  decided_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (asset_id, asset_version) REFERENCES asset_versions(asset_id, version),
  UNIQUE (asset_id, asset_version, reviewer_id)
);

CREATE TABLE IF NOT EXISTS app_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id text NOT NULL,
  app_version text NOT NULL,
  environment text NOT NULL CHECK (environment IN ('preview','staging','production')),
  status text NOT NULL CHECK (status IN ('staged','active','rolled_back','retired')),
  manifest_hash char(64) NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  activated_at timestamptz,
  FOREIGN KEY (app_id, app_version) REFERENCES asset_versions(asset_id, version)
);

CREATE TABLE IF NOT EXISTS app_release_pins (
  release_id uuid NOT NULL REFERENCES app_releases(id),
  asset_id text NOT NULL,
  asset_version text NOT NULL,
  asset_kind text NOT NULL CHECK (asset_kind IN ('a2ui','a2api','a2wf','app')),
  PRIMARY KEY (release_id, asset_id),
  FOREIGN KEY (asset_id, asset_version) REFERENCES asset_versions(asset_id, version)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id bigserial PRIMARY KEY,
  tenant_id text,
  actor_id text NOT NULL,
  action text NOT NULL,
  resource_type text NOT NULL,
  resource_id text NOT NULL,
  trace_id text,
  request_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_events_resource_idx ON audit_events(resource_type, resource_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_events_tenant_idx ON audit_events(tenant_id, occurred_at DESC);

-- Published versions are append-only. Corrections must create a new version.
CREATE OR REPLACE FUNCTION reject_published_asset_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' THEN
    RAISE EXCEPTION 'published asset version % is immutable', OLD.asset_id || '@' || OLD.version
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'DELETE' THEN\n    RETURN OLD;\n  END IF;\n  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS asset_versions_immutable ON asset_versions;
CREATE TRIGGER asset_versions_immutable
  BEFORE UPDATE OR DELETE ON asset_versions
  FOR EACH ROW EXECUTE FUNCTION reject_published_asset_mutation();
