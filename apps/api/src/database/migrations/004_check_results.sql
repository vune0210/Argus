-- Canonical result identity/time survives raw partition rollback and anchors cross-day dedup.
ALTER TABLE probe_results ADD CONSTRAINT probe_results_raw_identity UNIQUE (id, organization_id, received_at);

CREATE TABLE check_results (
  result_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  received_at timestamptz NOT NULL,
  result jsonb NOT NULL,
  PRIMARY KEY (received_at, result_id),
  FOREIGN KEY (result_id, organization_id, received_at)
    REFERENCES probe_results(id, organization_id, received_at) ON DELETE CASCADE
) PARTITION BY RANGE (received_at);
CREATE INDEX check_results_tenant_time_idx ON check_results (organization_id, received_at DESC);

CREATE FUNCTION argus_ensure_check_results_partition(partition_day date) RETURNS void
LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
DECLARE
  partition_name text;
BEGIN
  IF partition_day IS NULL OR NOT isfinite(partition_day) THEN
    RAISE EXCEPTION 'A finite UTC partition day is required';
  END IF;
  partition_name := 'check_results_' || to_char(partition_day, 'YYYYMMDD');
  IF to_regclass('public.' || partition_name) IS NOT NULL THEN RETURN; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('argus:check-results-partitions', 0));
  EXECUTE format('CREATE TABLE IF NOT EXISTS public.%I PARTITION OF public.check_results FOR VALUES FROM (%L) TO (%L)',
    partition_name, partition_day::text || ' 00:00:00+00', (partition_day + 1)::text || ' 00:00:00+00');
END;
$$;
SELECT argus_ensure_check_results_partition((now() AT TIME ZONE 'UTC')::date);
SELECT argus_ensure_check_results_partition((now() AT TIME ZONE 'UTC')::date + 1);
