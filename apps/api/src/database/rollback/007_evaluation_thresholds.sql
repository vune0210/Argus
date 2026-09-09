DROP INDEX IF EXISTS executions_evaluation_idempotency_unique;

ALTER TABLE executions
  DROP COLUMN IF EXISTS idempotency_key;

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_kind_check;

ALTER TABLE executions
  ADD CONSTRAINT executions_kind_check CHECK (kind IN ('SCHEDULED', 'MANUAL'));

ALTER TABLE monitors
  DROP COLUMN IF EXISTS failure_threshold,
  DROP COLUMN IF EXISTS recovery_threshold;
