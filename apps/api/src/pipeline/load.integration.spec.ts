import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { describe, expect, it } from "vitest";
import { OrganizationsService } from "../organizations/organizations.service";
import { PipelineService } from "./pipeline.service";
import { RedisStreams } from "./redis-streams";

const integration = process.env.DATABASE_URL && process.env.ARGUS_LOAD_GATE === "true" ? describe : describe.skip;
integration("1000-monitor scheduler load gate", () => {
  it("creates exactly 3000 targets with p95 scheduling lag below five seconds", async () => {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
    const redis = new RedisStreams();
    const orgs = new OrganizationsService(pool);
    const pipeline = new PipelineService(pool,orgs,redis);
    const user = `load-${randomUUID()}`;
    let org: string | undefined;
    try {
      org = (await orgs.bootstrap({ id:user,email:"load@example.test" })).organization.id;
      await pool.query(`INSERT INTO monitors(organization_id,name,interval_seconds,regions,config,created_by,updated_by)
        SELECT $1,'Load '||n,60,ARRAY['r1','r2','r3'],$2,$3,$3 FROM generate_series(1,1000) n`,
        [org,{kind:"http",url:"https://example.com",method:"GET",timeoutMs:5000,expectedStatus:200,maxRedirects:5,maxResponseBytes:1048576},user]);
      await Promise.all([0,1].map(async () => { while(await pipeline.schedule(100)) { /* drain due monitors */ } }));
      const count=await pool.query("SELECT count(*)::int AS count,count(DISTINCT monitor_id)::int AS monitors FROM executions WHERE organization_id=$1",[org]);
      expect(count.rows[0]).toEqual({count:1000,monitors:1000});
      expect((await pool.query("SELECT count(*)::int AS count FROM execution_targets WHERE organization_id=$1",[org])).rows[0].count).toBe(3000);
      const lag=(await pool.query(`SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM e.scheduled_at-m.created_at)) AS p95
        FROM executions e JOIN monitors m ON m.id=e.monitor_id WHERE e.organization_id=$1`,[org])).rows[0].p95;
      console.log(`Scheduler load gate: 1000 executions, 3000 targets, p95=${Number(lag).toFixed(3)}s`);
      expect(Number(lag)).toBeLessThan(5);
    } finally {
      if(org) await pool.query("DELETE FROM organizations WHERE id=$1",[org]);
      await pool.query("DELETE FROM users WHERE id=$1",[user]);
      await redis.onApplicationShutdown(); await pool.end();
    }
  },30000);
});
