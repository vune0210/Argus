-- Week 4 / Day 1: Incident response, notification channels, escalation policies and deliveries

ALTER TABLE incidents
  ADD COLUMN status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED')),
  ADD COLUMN acknowledged_at timestamptz,
  ADD COLUMN acknowledged_by text,
  ADD COLUMN resolved_by text;

UPDATE incidents
  SET status = CASE WHEN resolved_at IS NOT NULL THEN 'RESOLVED' ELSE 'OPEN' END;

ALTER TABLE incidents
  DROP CONSTRAINT IF EXISTS incidents_lifecycle_check;

ALTER TABLE incidents
  ADD CONSTRAINT incidents_lifecycle_check CHECK (
    (status = 'OPEN' AND acknowledged_at IS NULL AND acknowledged_by IS NULL AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status = 'ACKNOWLEDGED' AND acknowledged_at IS NOT NULL AND acknowledged_by IS NOT NULL AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status = 'RESOLVED' AND resolved_at IS NOT NULL)
  );

DROP INDEX IF EXISTS incidents_one_open;
CREATE UNIQUE INDEX incidents_one_unresolved ON incidents(monitor_id) WHERE status != 'RESOLVED';

ALTER TABLE incident_events
  ALTER COLUMN execution_id DROP NOT NULL,
  ADD COLUMN actor text;

ALTER TABLE incident_events
  DROP CONSTRAINT IF EXISTS incident_events_type_check;

ALTER TABLE incident_events
  ADD CONSTRAINT incident_events_type_check CHECK (type IN ('OPENED', 'ACKNOWLEDGED', 'RESOLVED'));

CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('SLACK', 'EMAIL')),
  name text NOT NULL,
  config jsonb NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, organization_id)
);
CREATE INDEX notification_channels_org_idx ON notification_channels(organization_id, type);

CREATE TABLE escalation_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE UNIQUE,
  name text NOT NULL DEFAULT 'Default Policy',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(id, organization_id)
);

CREATE TABLE escalation_policy_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  policy_id uuid NOT NULL,
  step_order integer NOT NULL CHECK (step_order >= 0),
  name text NOT NULL DEFAULT 'PRIMARY',
  delay_seconds integer NOT NULL CHECK (delay_seconds >= 0),
  channel_id uuid NOT NULL,
  FOREIGN KEY (policy_id, organization_id) REFERENCES escalation_policies(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, organization_id) REFERENCES notification_channels(id, organization_id) ON DELETE CASCADE,
  UNIQUE (policy_id, step_order),
  UNIQUE (id, organization_id)
);

CREATE TABLE notification_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  escalation_step_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  scheduled_at timestamptz NOT NULL,
  next_attempt_at timestamptz NOT NULL,
  locked_until timestamptz,
  last_attempted_at timestamptz,
  sent_at timestamptz,
  last_error text,
  provider_response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (incident_id, escalation_step_id),
  UNIQUE (id, organization_id),
  FOREIGN KEY (incident_id, organization_id) REFERENCES incidents(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (escalation_step_id, organization_id) REFERENCES escalation_policy_steps(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, organization_id) REFERENCES notification_channels(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX deliveries_claim_idx ON notification_deliveries(next_attempt_at, scheduled_at) WHERE status IN ('PENDING', 'FAILED') AND attempts < 5;
CREATE INDEX deliveries_incident_idx ON notification_deliveries(organization_id, incident_id);
