import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { backfillRawHistory, maintainRawPartitions } from "./raw-history";

const integration = process.env.DATABASE_URL ? describe : describe.skip;
integration("raw history populated rollback/backfill", () => {
  it("preserves canonical receipts across rollback/reapply and partitions UTC microseconds idempotently", async () => {
    const url = new URL(process.env.DATABASE_URL!);
    if (process.env.NODE_ENV !== "test" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("Requires isolated local NODE_ENV=test database");
    const admin = new Pool({ connectionString: url.toString() });
    const name = `argus_raw_${randomUUID().replaceAll("-", "")}`;
    let pool: Pool | undefined;
    const sql = (directory: string, file: string) => readFile(resolve(__dirname, "../database", directory, file), "utf8");
    try {
      await admin.query(`CREATE DATABASE ${name}`); url.pathname = `/${name}`;
      pool = new Pool({ connectionString: url.toString() });
      for (const file of ["001_initial.sql", "002_tenant_integrity.sql", "003_execution_pipeline.sql"]) await pool.query(await sql("migrations", file));
      const org = randomUUID(), monitor = randomUUID(), execution = randomUUID();
      await pool.query("INSERT INTO users(id,email) VALUES('raw-fixture','raw@example.test')");
      await pool.query("INSERT INTO organizations(id,name,slug) VALUES($1,'Raw fixture','raw-fixture')", [org]);
      await pool.query(`INSERT INTO monitors(id,organization_id,name,interval_seconds,regions,config,created_by,updated_by)
        VALUES($1,$2,'Fixture',60,ARRAY['ap-southeast-1','eu-central-1'],'{"kind":"http"}','raw-fixture','raw-fixture')`, [monitor,org]);
      await pool.query(`INSERT INTO executions(id,organization_id,monitor_id,monitor_version,kind,scheduled_at,deadline_at,config)
        VALUES($1,$2,$3,1,'SCHEDULED','2026-09-06T23:59:00Z','2026-09-07T00:01:30Z','{"kind":"http"}')`, [execution,org,monitor]);
      for (const [region, time] of [["ap-southeast-1","2026-09-06T23:59:59.999999Z"], ["eu-central-1","2026-09-07T00:00:00.000001Z"]]) {
        const target = randomUUID();
        await pool.query("INSERT INTO execution_targets(id,organization_id,execution_id,region,status) VALUES($1,$2,$3,$4,'COMPLETED')", [target,org,execution,region]);
        await pool.query("INSERT INTO probe_results(organization_id,target_id,received_at,result) VALUES($1,$2,$3,'{\"outcome\":\"PASS\"}')", [org,target,time]);
      }
      const canonical = async () => (await pool!.query("SELECT id,receipt_id,received_at::text,result FROM probe_results ORDER BY id")).rows;
      const before = await canonical();
      const up = await sql("migrations", "004_check_results.sql"), down = await sql("rollback", "004_check_results.sql");
      for (let round = 0; round < 2; round++) {
        await pool.query(up);
        await maintainRawPartitions(pool);
        const counts = await Promise.all([backfillRawHistory(pool, 1), backfillRawHistory(pool, 1)]);
        expect(counts.reduce((a,b) => a+b, 0)).toBe(2);
        expect(await backfillRawHistory(pool)).toBe(0);
        const raw = await pool.query("SELECT tableoid::regclass::text AS partition FROM check_results ORDER BY received_at");
        expect(raw.rows.map((r) => r.partition)).toEqual(["check_results_20260906", "check_results_20260907"]);
        expect(await canonical()).toEqual(before);
        await pool.query(down);
        expect(await canonical()).toEqual(before);
        expect((await pool.query("SELECT to_regclass('check_results') AS raw")).rows[0].raw).toBeNull();
      }
      await pool.query(up); expect(await backfillRawHistory(pool)).toBe(2);
    } finally {
      await pool?.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name}`); await admin.end();
    }
  }, 30_000);
});
