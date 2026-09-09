ALTER TABLE monitors
  ADD COLUMN next_run_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN consecutive_passes integer NOT NULL DEFAULT 0,
  ADD COLUMN flapping_until timestamptz,
  ADD COLUMN last_evaluated_execution_id uuid,
  ADD COLUMN last_evaluated_sequence bigint NOT NULL DEFAULT 0,
  ADD COLUMN deleted_at timestamptz;
CREATE INDEX monitors_due_idx ON monitors(next_run_at, id) WHERE deleted_at IS NULL;

CREATE TABLE executions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL,
  monitor_version integer NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SCHEDULED','MANUAL')),
  status text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','RUNNING','COMPLETED')),
  scheduled_at timestamptz NOT NULL,
  deadline_at timestamptz NOT NULL,
  completed_at timestamptz,
  observation text CHECK (observation IN ('QUORUM_PASS','QUORUM_FAILURE','SINGLE_REGION_FAILURE','INSUFFICIENT_RESULTS')),
  config jsonb NOT NULL,
  UNIQUE(id, organization_id),
  FOREIGN KEY(monitor_id, organization_id) REFERENCES monitors(id, organization_id) ON DELETE CASCADE,
  CHECK(deadline_at > scheduled_at)
);
CREATE UNIQUE INDEX executions_schedule_unique ON executions(monitor_id, scheduled_at) WHERE kind = 'SCHEDULED';
CREATE INDEX executions_monitor_idx ON executions(organization_id, monitor_id, sequence DESC);
CREATE INDEX executions_deadline_idx ON executions(deadline_at) WHERE completed_at IS NULL;

CREATE TABLE probe_agents (
  id text PRIMARY KEY,
  token_digest text NOT NULL,
  region text NOT NULL,
  status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','DISABLED')),
  is_development boolean NOT NULL DEFAULT false,
  last_seen_at timestamptz
);
CREATE TABLE execution_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  execution_id uuid NOT NULL,
  region text NOT NULL,
  status text NOT NULL DEFAULT 'QUEUED' CHECK(status IN ('QUEUED','LEASED','COMPLETED','EXPIRED','DEAD')),
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
  lease_id uuid UNIQUE,
  probe_id text REFERENCES probe_agents(id),
  lease_expires_at timestamptz,
  stream_id text,
  published_at timestamptz,
  UNIQUE(execution_id, region),
  UNIQUE(id, organization_id),
  FOREIGN KEY(execution_id, organization_id) REFERENCES executions(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX execution_targets_reclaim_idx ON execution_targets(lease_expires_at) WHERE status = 'LEASED';
CREATE TABLE probe_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  target_id uuid NOT NULL UNIQUE,
  receipt_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  result jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(target_id, organization_id) REFERENCES execution_targets(id, organization_id) ON DELETE CASCADE
);
CREATE TABLE monitor_state_transitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL,
  execution_id uuid NOT NULL UNIQUE,
  from_state text NOT NULL,
  to_state text NOT NULL,
  observation text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(monitor_id, organization_id) REFERENCES monitors(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY(execution_id, organization_id) REFERENCES executions(id, organization_id) ON DELETE CASCADE
);
CREATE INDEX transitions_window_idx ON monitor_state_transitions(monitor_id, occurred_at DESC);
CREATE TABLE incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  monitor_id uuid NOT NULL,
  opened_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  UNIQUE(id, organization_id),
  FOREIGN KEY(monitor_id, organization_id) REFERENCES monitors(id, organization_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX incidents_one_open ON incidents(monitor_id) WHERE resolved_at IS NULL;
CREATE INDEX incidents_tenant_idx ON incidents(organization_id, opened_at DESC);
CREATE TABLE incident_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  incident_id uuid NOT NULL,
  execution_id uuid NOT NULL,
  type text NOT NULL CHECK(type IN ('OPENED','RESOLVED')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(incident_id, organization_id) REFERENCES incidents(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY(execution_id, organization_id) REFERENCES executions(id, organization_id) ON DELETE CASCADE
);
CREATE TABLE domain_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  envelope jsonb NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_events_replay_idx ON domain_events(organization_id, sequence);
CREATE TABLE outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  dedup_key text NOT NULL UNIQUE,
  stream text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX outbox_pending_idx ON outbox_events(created_at) WHERE published_at IS NULL;
