-- Migration 008: Multichannel escalation steps and recovery notifications

CREATE TABLE escalation_step_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  step_id uuid NOT NULL,
  channel_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (step_id, organization_id) REFERENCES escalation_policy_steps(id, organization_id) ON DELETE CASCADE,
  FOREIGN KEY (channel_id, organization_id) REFERENCES notification_channels(id, organization_id) ON DELETE CASCADE,
  UNIQUE (step_id, channel_id),
  UNIQUE (id, organization_id)
);
CREATE INDEX escalation_step_channels_step_idx ON escalation_step_channels(step_id);

-- Backfill from legacy escalation_policy_steps.channel_id
INSERT INTO escalation_step_channels (organization_id, step_id, channel_id)
SELECT s.organization_id, s.id, s.channel_id
FROM escalation_policy_steps s
WHERE s.channel_id IS NOT NULL
ON CONFLICT (step_id, channel_id) DO NOTHING;

-- Add event_kind to notification_deliveries
ALTER TABLE notification_deliveries
  ADD COLUMN event_kind text NOT NULL DEFAULT 'INCIDENT_OPENED'
  CHECK (event_kind IN ('INCIDENT_OPENED', 'INCIDENT_RESOLVED'));

-- Allow escalation_step_id to be nullable for recovery notifications if needed
ALTER TABLE notification_deliveries
  ALTER COLUMN escalation_step_id DROP NOT NULL;

-- Drop legacy unique constraint
ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_incident_id_escalation_step_id_key;

-- Unique constraint for incident opened notifications
DROP INDEX IF EXISTS notification_deliveries_opened_uniq;
CREATE UNIQUE INDEX notification_deliveries_opened_uniq
  ON notification_deliveries (incident_id, escalation_step_id, channel_id)
  WHERE event_kind = 'INCIDENT_OPENED';

-- Unique constraint for incident recovery notifications
DROP INDEX IF EXISTS notification_deliveries_resolved_uniq;
CREATE UNIQUE INDEX notification_deliveries_resolved_uniq
  ON notification_deliveries (incident_id, channel_id)
  WHERE event_kind = 'INCIDENT_RESOLVED';
