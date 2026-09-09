CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(120) NOT NULL,
  slug varchar(140) NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS organization_members (
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('OWNER', 'ADMIN', 'RESPONDER', 'VIEWER')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, user_id)
);

CREATE TABLE IF NOT EXISTS monitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds >= 60),
  regions text[] NOT NULL,
  health_state varchar(24) NOT NULL DEFAULT 'UNKNOWN' CHECK (health_state IN ('UNKNOWN', 'HEALTHY', 'DEGRADED', 'PENDING_DOWN', 'DOWN', 'PENDING_RECOVERY')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  config jsonb NOT NULL,
  created_by text NOT NULL REFERENCES users(id),
  updated_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT monitors_regions_nonempty CHECK (cardinality(regions) > 0),
  CONSTRAINT monitors_config_http CHECK (config->>'kind' = 'http')
);

CREATE INDEX IF NOT EXISTS monitors_organization_created_idx ON monitors (organization_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS monitor_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version >= 1),
  name varchar(120) NOT NULL,
  interval_seconds integer NOT NULL,
  regions text[] NOT NULL,
  config jsonb NOT NULL,
  changed_by text NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (monitor_id, version)
);

CREATE INDEX IF NOT EXISTS monitor_versions_tenant_idx ON monitor_versions (organization_id, monitor_id, version DESC);
