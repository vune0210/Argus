import type { Pool } from "pg";

/** Maintenance, never called from ingestion. Uses database UTC rather than process timezone. */
export async function maintainRawPartitions(pool: Pool): Promise<void> {
  await pool.query(`SELECT argus_ensure_check_results_partition(day::date)
    FROM (VALUES ((now() AT TIME ZONE 'UTC')::date), ((now() AT TIME ZONE 'UTC')::date + 1)) AS days(day)`);
}

/** Canonical receipt identity/time determines the destination, including retry after midnight. */
export async function backfillRawHistory(pool: Pool, batchSize = 1000): Promise<number> {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error("Batch size must be 1..10000");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Serialize DDL/backfill before taking any relation locks: concurrent maintainers cannot deadlock on an upgrade.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('argus:check-results-partitions', 0))");
    const batch = await client.query(`SELECT r.id,(r.received_at AT TIME ZONE 'UTC')::date::text AS day FROM probe_results r
      WHERE NOT EXISTS (SELECT 1 FROM check_results c WHERE c.received_at=r.received_at AND c.result_id=r.id)
      ORDER BY r.received_at,r.id LIMIT $1`, [batchSize]);
    for (const day of new Set(batch.rows.map((row) => row.day))) await client.query("SELECT argus_ensure_check_results_partition($1::date)", [day]);
    const inserted = await client.query(`INSERT INTO check_results(result_id,organization_id,received_at,result)
      SELECT id,organization_id,received_at,result FROM probe_results WHERE id=ANY($1::uuid[])
      ON CONFLICT (received_at,result_id) DO NOTHING`, [batch.rows.map((row) => row.id)]);
    await client.query("COMMIT");
    return inserted.rowCount ?? 0;
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
