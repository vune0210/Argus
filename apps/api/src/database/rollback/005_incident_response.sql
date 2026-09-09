-- Rollback for 005_incident_response.sql

DROP TABLE IF EXISTS notification_deliveries;
DROP TABLE IF EXISTS escalation_policy_steps;
DROP TABLE IF EXISTS escalation_policies;
DROP TABLE IF EXISTS notification_channels;

ALTER TABLE incident_events DROP COLUMN IF EXISTS actor;
ALTER TABLE incident_events DROP CONSTRAINT IF EXISTS incident_events_type_check;
ALTER TABLE incident_events ADD CONSTRAINT incident_events_type_check CHECK (type IN ('OPENED', 'RESOLVED'));
ALTER TABLE incident_events ALTER COLUMN execution_id SET NOT NULL;

DROP INDEX IF EXISTS incidents_one_unresolved;
CREATE UNIQUE INDEX incidents_one_open ON incidents(monitor_id) WHERE resolved_at IS NULL;

ALTER TABLE incidents
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS acknowledged_at,
  DROP COLUMN IF EXISTS acknowledged_by,
  DROP COLUMN IF EXISTS resolved_by;
