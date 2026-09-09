-- Rollback 008: Multichannel escalation steps and recovery notifications (test databases only)

DROP INDEX IF EXISTS notification_deliveries_resolved_uniq;
DROP INDEX IF EXISTS notification_deliveries_opened_uniq;

ALTER TABLE notification_deliveries
  DROP CONSTRAINT IF EXISTS notification_deliveries_event_kind_check;

ALTER TABLE notification_deliveries
  DROP COLUMN IF EXISTS event_kind;

DROP TABLE IF EXISTS escalation_step_channels;

-- Re-enable NOT NULL on escalation_step_id if all have it
UPDATE notification_deliveries SET escalation_step_id = (SELECT id FROM escalation_policy_steps LIMIT 1) WHERE escalation_step_id IS NULL;
ALTER TABLE notification_deliveries ALTER COLUMN escalation_step_id SET NOT NULL;

-- Restore legacy unique constraint
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_incident_id_escalation_step_id_key UNIQUE (incident_id, escalation_step_id);
