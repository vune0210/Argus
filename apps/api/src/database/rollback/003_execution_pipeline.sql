-- Destructive rollback: use only on an isolated test database.
DROP TABLE outbox_events, domain_events, incident_events, incidents, monitor_state_transitions, probe_results, execution_targets, probe_agents, executions;
ALTER TABLE monitors DROP COLUMN next_run_at, DROP COLUMN consecutive_failures, DROP COLUMN consecutive_passes,
  DROP COLUMN flapping_until, DROP COLUMN last_evaluated_execution_id, DROP COLUMN last_evaluated_sequence, DROP COLUMN deleted_at;
