-- Roll application/worker back first. Raw copies are reconstructible from probe_results.
DROP TABLE check_results;
DROP FUNCTION argus_ensure_check_results_partition(date);
ALTER TABLE probe_results DROP CONSTRAINT probe_results_raw_identity;
