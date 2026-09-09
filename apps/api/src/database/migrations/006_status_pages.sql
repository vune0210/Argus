-- Week 4 / Day 4: Status pages and components

CREATE TABLE status_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL CHECK (length(trim(name)) >= 1 AND length(trim(name)) <= 120),
  slug varchar(63) NOT NULL CHECK (length(slug) >= 3 AND length(slug) <= 63 AND slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  description text,
  published boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by varchar(64) NOT NULL DEFAULT 'system',
  updated_by varchar(64) NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE(id, organization_id)
);

CREATE UNIQUE INDEX idx_status_pages_slug_active ON status_pages (LOWER(slug)) WHERE deleted_at IS NULL;
CREATE INDEX idx_status_pages_org_active ON status_pages (organization_id) WHERE deleted_at IS NULL;

CREATE TABLE status_page_components (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status_page_id uuid NOT NULL,
  monitor_id uuid NOT NULL,
  public_name varchar(80) NOT NULL CHECK (length(trim(public_name)) >= 1 AND length(trim(public_name)) <= 80),
  position integer NOT NULL CHECK (position >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (status_page_id, organization_id) REFERENCES status_pages(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (monitor_id, organization_id) REFERENCES monitors(id, organization_id) ON DELETE CASCADE,
  UNIQUE (status_page_id, monitor_id),
  UNIQUE (status_page_id, position),
  UNIQUE (id, organization_id)
);

CREATE INDEX idx_status_page_components_page ON status_page_components(status_page_id);

ALTER TABLE monitors DROP CONSTRAINT IF EXISTS monitors_config_http;
ALTER TABLE monitors DROP CONSTRAINT IF EXISTS monitors_config_kind;
ALTER TABLE monitors ADD CONSTRAINT monitors_config_kind CHECK (config->>'kind' IN ('http', 'tcp', 'ssl', 'keyword'));
