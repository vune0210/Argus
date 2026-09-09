-- Week 4: Incident policy thresholds, EVALUATION execution kind, and idempotency key

ALTER TABLE monitors
  ADD COLUMN failure_threshold integer NOT NULL DEFAULT 2 CHECK (failure_threshold BETWEEN 1 AND 5),
  ADD COLUMN recovery_threshold integer NOT NULL DEFAULT 2 CHECK (recovery_threshold BETWEEN 1 AND 5);

UPDATE monitors
  SET failure_threshold = 2, recovery_threshold = 2
  WHERE failure_threshold IS NULL OR recovery_threshold IS NULL;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_kind_check;

ALTER TABLE executions
  ADD CONSTRAINT executions_kind_check CHECK (kind IN ('SCHEDULED', 'MANUAL', 'EVALUATION'));

ALTER TABLE executions
  ADD COLUMN idempotency_key text;

CREATE UNIQUE INDEX executions_evaluation_idempotency_unique
  ON executions(organization_id, monitor_id, idempotency_key)
  WHERE kind = 'EVALUATION' AND idempotency_key IS NOT NULL;
