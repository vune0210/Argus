import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ProbeLease, ProbeResult } from "@argus/contracts";
import { OrganizationsService } from "../organizations/organizations.service";
import { MonitorsService } from "../monitors/monitors.service";
import { PipelineService } from "./pipeline.service";
import { GROUP, RedisStreams, jobStream } from "./redis-streams";
import { digestToken, probeKey } from "./probe-auth";
import { backfillRawHistory, maintainRawPartitions } from "./raw-history";

const integration = process.env.DATABASE_URL && process.env.REDIS_URL ? describe : describe.skip;
integration("execution pipeline: PostgreSQL and Redis", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 20 });
  const streams = new RedisStreams();
  const orgs = new OrganizationsService(pool);
  const monitors = new MonitorsService(pool, orgs);
  const pipeline = new PipelineService(pool, orgs, streams);
  const uid = randomUUID();
  const user = `pipeline-${uid}`;
  const viewer = `viewer-${uid}`;
  const responder = `responder-${uid}`;
  let org: string;
  const regions = [`r1-${uid.slice(0,8)}`, `r2-${uid.slice(0,8)}`, `r3-${uid.slice(0,8)}`];
  const probes = regions.map((region) => ({ id: `probe-${region}`, region }));
  const input = { name: "Pipeline integration", intervalSeconds: 60, regions,
    config: { kind: "http" as const, url: "https://example.com", method: "GET" as const, timeoutMs: 5000, expectedStatus: 200, maxRedirects: 5, maxResponseBytes: 1048576 } };
  beforeAll(async () => {
    await maintainRawPartitions(pool);
    org = (await orgs.bootstrap({ id: user, email: "pipeline@example.test" })).organization.id;
    for (const [id, role] of [[viewer, "VIEWER"], [responder, "RESPONDER"]]) {
      await pool.query("INSERT INTO users(id,email) VALUES($1,'test@example.test')", [id]);
      await pool.query("INSERT INTO organization_members(organization_id,user_id,role) VALUES($1,$2,$3)", [org,id,role]);
    }
    for (const p of probes) await pool.query("INSERT INTO probe_agents(id,region,token_digest,is_development) VALUES($1,$2,$3,true)", [p.id,p.region,digestToken(`argp_${p.id}.test-integration-secret`,probeKey())]);
  });
  afterAll(async () => {
    if (org) {
      for (let i = 0; i < 5; i++) {
        try { await pool.query("DELETE FROM organizations WHERE id=$1", [org]); break; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
    }
    await pool.query("DELETE FROM users WHERE id=ANY($1)", [[user, viewer, responder]]).catch(() => undefined);
    try {
      await pool.query("DELETE FROM execution_targets WHERE probe_id=ANY($1)", [probes.map((p) => p.id)]);
      await pool.query("DELETE FROM probe_agents WHERE id=ANY($1)", [probes.map((p) => p.id)]);
    } catch {}
    for (const r of regions) await streams.command(["DEL", jobStream(r), `${jobStream(r)}:dlq`]).catch(() => undefined);
    await streams.onApplicationShutdown(); await pool.end();
  });
  async function create() {
    const monitor = await monitors.create(org,user,input);
    await pool.query("UPDATE monitors SET next_run_at=now()+interval '1 day' WHERE id=$1", [monitor.id]);
    return monitor;
  }
  async function scheduled(id: string) {
    await pool.query("UPDATE monitors SET next_run_at=now() WHERE id=$1", [id]);
    await Promise.all([pipeline.schedule(), pipeline.schedule()]);
    await pipeline.dispatch(1000);
    return (await pipeline.executions(org,user,id)).items[0]!;
  }
  function result(lease: ProbeLease, index: number, outcome: "PASS" | "FAIL"): ProbeResult {
    // Synthetic checks use the authoritative execution clock, not Docker/host wall-clock skew.
    const now = lease.job.scheduledAt;
    return { schemaVersion: "0.1", executionId: lease.job.executionId, monitorId: lease.job.monitorId, monitorVersion: lease.job.monitorVersion,
      organizationId: lease.job.organizationId, probeId: probes[index]!.id, region: regions[index]!, startedAt: now, completedAt: now, durationMs: 0, outcome,
      ...(outcome === "FAIL" ? { errorCode: "CONNECT" as const, errorMessage: "connect failed" } : { http: { statusCode: 200, responseBytes: 12 } }) };
  }
  async function take(index: number, executionId: string): Promise<ProbeLease> {
    for (let i = 0; i < 100; i++) {
      const lease = await pipeline.lease(probes[index]!);
      if (lease?.job.executionId === executionId) return lease;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Expected a lease for execution");
  }
  async function complete(id: string, outcomes: ("PASS" | "FAIL")[]) {
    const e = await scheduled(id);
    for (let i=0;i<outcomes.length;i++) {
      const lease = await take(i,e.id);
      await pipeline.ingest(probes[i]!,lease.leaseId,result(lease,i,outcomes[i]!));
    }
    await Promise.all([pipeline.finalize(),pipeline.finalize()]);
    return e;
  }
  it("concurrent schedulers create one scheduled execution and three targets", async () => {
    const m = await create(); const e = await scheduled(m.id);
    expect((await pipeline.executions(org,user,m.id)).items).toHaveLength(1);
    expect((await pipeline.execution(org,user,e.id)).targets).toHaveLength(3);
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1", [e.id]);
    await pipeline.finalize();
    expect((await pipeline.execution(org,user,e.id)).observation).toBe("INSUFFICIENT_RESULTS");
    expect((await monitors.get(org,user,m.id)).healthState).toBe("UNKNOWN");
  });
  it("commits before ACK and returns one identical receipt under concurrent duplicate submissions", async () => {
    const m = await create(); const e = await scheduled(m.id); const lease = await take(0,e.id);
    const value = result(lease,0,"PASS");
    const receipts = await Promise.all([pipeline.ingest(probes[0]!,lease.leaseId,value),pipeline.ingest(probes[0]!,lease.leaseId,value)]);
    expect(new Set(receipts.map((r) => r.receiptId)).size).toBe(1);
    expect(receipts.map((r) => r.duplicate).sort()).toEqual([false,true]);
    const pending = await streams.command(["XPENDING",jobStream(regions[0]!),GROUP]) as [number];
    expect(pending[0]).toBe(0);
    await expect(pipeline.ingest(probes[0]!,lease.leaseId,{ ...value,durationMs: 1 })).rejects.toMatchObject({ status:409 });
    await expect(pipeline.ingest(probes[1]!,lease.leaseId,value)).rejects.toMatchObject({ status:410 });
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1",[e.id]); await pipeline.finalize();
    expect((await pipeline.ingest(probes[0]!,lease.leaseId,value)).duplicate).toBe(true);
  });
  it("opens one incident after two quorum failures and resolves after two clean passes", async () => {
    const m = await create();
    await complete(m.id,["FAIL","FAIL","PASS"]);
    expect((await monitors.get(org,user,m.id)).healthState).toBe("PENDING_DOWN");
    await complete(m.id,["FAIL","FAIL","PASS"]);
    expect((await monitors.get(org,user,m.id)).healthState).toBe("DOWN");
    await complete(m.id,["FAIL","FAIL","FAIL"]);
    const opened = (await pipeline.incidents(org,user)).items.filter((i) => i.monitorId === m.id);
    expect(opened).toHaveLength(1);
    await complete(m.id,["PASS","PASS","PASS"]);
    expect((await monitors.get(org,user,m.id)).healthState).toBe("PENDING_RECOVERY");
    await complete(m.id,["PASS","PASS","PASS"]);
    expect((await monitors.get(org,user,m.id)).healthState).toBe("HEALTHY");
    const detail = await pipeline.incident(org,viewer,opened[0]!.id);
    expect(detail.resolvedAt).not.toBeNull(); expect(detail.events.map((e) => e.type)).toEqual(["OPENED","RESOLVED"]);
  });
  it("manual executions preserve health; RBAC, tenant queries and soft-delete preserve history", async () => {
    const m=await create();
    await expect(pipeline.run(org,viewer,m.id)).rejects.toMatchObject({status:403});
    const e=await pipeline.run(org,responder,m.id); await pipeline.dispatch(1000);
    for(let i=0;i<3;i++){const lease=await take(i,e.id);await pipeline.ingest(probes[i]!,lease.leaseId,result(lease,i,"FAIL"));}
    await pipeline.finalize();
    expect((await monitors.get(org,user,m.id)).healthState).toBe("UNKNOWN");
    await expect(pipeline.execution(randomUUID(),user,e.id)).rejects.toMatchObject({status:404});
    await monitors.delete(org,user,m.id);
    await expect(monitors.get(org,user,m.id)).rejects.toMatchObject({status:404});
    expect((await pipeline.execution(org,viewer,e.id)).status).toBe("COMPLETED");
    await expect(pipeline.run(org,user,m.id)).rejects.toMatchObject({status:404});
  });
  it("reclaims expired leases, fences old owners, then moves poison targets to DLQ", async () => {
    const m=await create();const e=await scheduled(m.id); let lease=await take(0,e.id);
    const old=lease;
    for(let attempt=1;attempt<=3;attempt++){
      await pool.query("UPDATE execution_targets SET lease_expires_at=now()-interval '1 second' WHERE lease_id=$1",[lease.leaseId]);
      const target=(await pool.query("SELECT stream_id FROM execution_targets WHERE lease_id=$1",[lease.leaseId])).rows[0];
      await streams.command(["XCLAIM",jobStream(regions[0]!),GROUP,probes[0]!.id,"0",target.stream_id,"IDLE","46000","JUSTID"]);
      const next=await pipeline.lease(probes[0]!);
      if(attempt<3){expect(next).not.toBeNull();lease=next!;}else expect(next).toBeNull();
    }
    await expect(pipeline.ingest(probes[0]!,old.leaseId,result(old,0,"PASS"))).rejects.toMatchObject({status:410});
    await pipeline.dispatch(1000);
    expect((await streams.command(["XLEN",`${jobStream(regions[0]!)}:dlq`]))).toBe(1);
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1",[e.id]);await pipeline.finalize();
  });
  it("reconstructs queued work after Redis stream loss using PostgreSQL outbox", async () => {
    const m=await create(); const e=await scheduled(m.id);
    await streams.command(["DEL",jobStream(regions[0]!)]);
    await pool.query("UPDATE outbox_events SET published_at=now()-interval '46 seconds' WHERE payload->>'targetId' IN (SELECT id::text FROM execution_targets WHERE execution_id=$1)",[e.id]);
    await pipeline.repair(); await pipeline.dispatch(1000);
    const lease=await take(0,e.id);
    expect(lease.job.executionId).toBe(e.id);
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1",[e.id]);await pipeline.finalize();
  });
  it("snapshots show no data until a scheduled result exists and never expose other tenant assignments", async () => {
    const m = await create();
    const empty = await pipeline.snapshot(org, viewer, m.id);
    expect(empty.regions).toHaveLength(3);
    expect(empty.regions.every((r) => r.latencyMs === null && r.outcome === null && r.heartbeat.status === "UNKNOWN")).toBe(true);
    const e = await pipeline.run(org, user, m.id); await pipeline.dispatch(1000);
    const lease = await take(0, e.id);
    await pipeline.ingest(probes[0]!, lease.leaseId, result(lease, 0, "PASS"));
    expect((await pipeline.snapshot(org, viewer, m.id)).regions[0]!.outcome).toBeNull();
    const foreignUser = `snapshot-${randomUUID()}`;
    const foreign = await orgs.bootstrap({ id: foreignUser, email: "snapshot-b@example.test" });
    try {
      await expect(pipeline.snapshot(foreign.organization.id, foreignUser, m.id)).rejects.toMatchObject({ status: 404 });
      await expect(pipeline.snapshot(org, foreignUser, m.id)).rejects.toMatchObject({ status: 404 });
      const own = await monitors.create(foreign.organization.id, foreignUser, input);
      const clean = await pipeline.snapshot(foreign.organization.id, foreignUser, own.id);
      expect(clean.regions.every((r) => r.heartbeat.lastSeenAt === null && r.executionId === null)).toBe(true);
    } finally {
      for (let i = 0; i < 5; i++) {
        try { await pool.query("DELETE FROM organizations WHERE id=$1", [foreign.organization.id]); break; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
      await pool.query("DELETE FROM users WHERE id=$1", [foreignUser]).catch(() => undefined);
    }
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1", [e.id]); await pipeline.finalize();
  });
  it("latest scheduled sequence wins over arrival order, duplicates emit one invalidation, version changes clear results", async () => {
    const m = await create(); const old = await scheduled(m.id); const oldLease = await take(0, old.id);
    const newer = await scheduled(m.id); const newLease = await take(0, newer.id);
    await pipeline.ingest(probes[0]!, newLease.leaseId, result(newLease, 0, "PASS"));
    const late = result(oldLease, 0, "FAIL");
    await pipeline.ingest(probes[0]!, oldLease.leaseId, late);
    await pipeline.ingest(probes[0]!, oldLease.leaseId, late);
    const current = await pipeline.snapshot(org, viewer, m.id);
    expect(current.regions[0]).toMatchObject({ executionId: newer.id, outcome: "PASS", latencyMs: 0, freshness: "FRESH" });
    const emitted = await pool.query("SELECT count(*)::int AS n FROM domain_events WHERE organization_id=$1 AND envelope->>'type'='probe.result_received' AND envelope->'payload'->>'executionId'=$2", [org, old.id]);
    expect(emitted.rows[0].n).toBe(1);
    await monitors.update(org, user, m.id, { ...input, version: m.version });
    expect((await pipeline.snapshot(org, user, m.id)).regions.every((r) => r.freshness === "NO_DATA")).toBe(true);
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE monitor_id=$1", [m.id]); await pipeline.finalize();
  });
  it("heartbeat ageing is independent of check outcome and probe credentials remain private", async () => {
    const m = await create(); await complete(m.id, ["PASS", "PASS", "PASS"]);
    await pool.query("UPDATE probe_agents SET last_seen_at=now() WHERE id=$1", [probes[0]!.id]);
    expect((await pipeline.snapshot(org, user, m.id)).regions[0]!.heartbeat.status).toBe("ALIVE");
    await pool.query("UPDATE probe_agents SET last_seen_at=now()-interval '61 seconds' WHERE id=$1", [probes[0]!.id]);
    const stale = await pipeline.snapshot(org, user, m.id);
    expect(stale.regions[0]).toMatchObject({ outcome: "PASS", freshness: "FRESH", heartbeat: { status: "STALE" } });
    expect(JSON.stringify(stale)).not.toContain("token_digest");
    expect(JSON.stringify(stale)).not.toContain(probes[0]!.id);
    await pool.query("UPDATE executions SET scheduled_at=scheduled_at-interval '5 minutes' WHERE monitor_id=$1", [m.id]);
    expect((await pipeline.snapshot(org, user, m.id)).regions[0]!.freshness).toBe("STALE");
  });
  it("rejects result identity mismatches without persisting or ACKing the valid lease", async () => {
    const m = await create(); const e = await scheduled(m.id); const lease = await take(0, e.id);
    const valid = result(lease, 0, "PASS");
    for (const change of [{ organizationId: randomUUID() }, { executionId: randomUUID() }, { monitorId: randomUUID() }, { monitorVersion: 999 }, { region: regions[1]! }, { probeId: probes[1]!.id }]) {
      await expect(pipeline.ingest(probes[0]!, lease.leaseId, { ...valid, ...change })).rejects.toMatchObject({ status: 409 });
    }
    expect((await pipeline.snapshot(org, user, m.id)).regions[0]!.outcome).toBeNull();
    expect((await pipeline.ingest(probes[0]!, lease.leaseId, valid)).duplicate).toBe(false);
    await pool.query("UPDATE executions SET deadline_at=scheduled_at+interval '1 millisecond' WHERE id=$1", [e.id]); await pipeline.finalize();
  });
  it("reassigns a crashed probe lease to a different probe and fences the previous owner", async () => {
    const replacement = { id: `replacement-${uid}`, region: regions[0]! };
    await pool.query("INSERT INTO probe_agents(id,region,token_digest,is_development) VALUES($1,$2,'test-only',true)", [replacement.id, replacement.region]);
    const m = await create(); const e = await scheduled(m.id); const old = await take(0, e.id);
    try {
      await pool.query("UPDATE execution_targets SET lease_expires_at=now()-interval '1 second' WHERE lease_id=$1", [old.leaseId]);
      const t = (await pool.query("SELECT stream_id FROM execution_targets WHERE lease_id=$1", [old.leaseId])).rows[0];
      await streams.command(["XCLAIM", jobStream(replacement.region), GROUP, probes[0]!.id, "0", t.stream_id, "IDLE", "46000", "JUSTID"]);
      const next = await pipeline.lease(replacement);
      expect(next?.job.executionId).toBe(e.id); expect(next!.leaseId).not.toBe(old.leaseId);
      await expect(pipeline.heartbeat(probes[0]!, old.leaseId)).rejects.toMatchObject({ status: 410 });
      await expect(pipeline.ingest(probes[0]!, old.leaseId, result(old, 0, "PASS"))).rejects.toMatchObject({ status: 410 });
      const value = { ...result(next!, 0, "PASS"), probeId: replacement.id };
      const receipt = await pipeline.ingest(replacement, next!.leaseId, value);
      expect((await pipeline.ingest(replacement, next!.leaseId, value)).receiptId).toBe(receipt.receiptId);
      expect((await pipeline.execution(org, user, e.id)).targets.filter((target) => target.result)).toHaveLength(1);
    } finally {
      await pool.query("DELETE FROM monitors WHERE id=$1", [m.id]);
      await pool.query("DELETE FROM probe_agents WHERE id=$1", [replacement.id]);
    }
  });
  it("raw insert failure rolls back canonical result, target completion and outbox without ACK", async () => {
    const name = `reject_raw_${uid.replaceAll("-", "")}`;
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.organization_id::text=TG_ARGV[0] THEN RAISE EXCEPTION 'injected raw storage failure'; END IF; RETURN NEW; END $$`);
    await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON check_results FOR EACH ROW EXECUTE FUNCTION ${name}('${org}')`);
    const m = await create(); const e = await scheduled(m.id); const lease = await take(0, e.id);
    const ack = vi.spyOn(streams, "ack");
    try {
      await expect(pipeline.ingest(probes[0]!, lease.leaseId, result(lease, 0, "PASS"))).rejects.toThrow("injected raw storage failure");
      expect(ack).not.toHaveBeenCalled();
      const t = (await pipeline.execution(org, user, e.id)).targets.find((target) => target.region === regions[0])!;
      expect(t).toMatchObject({ status: "LEASED", result: null });
      expect((await pool.query("SELECT count(*)::int AS n FROM domain_events WHERE envelope->>'correlationId'=$1", [e.id])).rows[0].n).toBe(0);
    } finally {
      ack.mockRestore();
      await pool.query(`DROP TRIGGER ${name} ON check_results`); await pool.query(`DROP FUNCTION ${name}()`);
    }
    expect((await pipeline.ingest(probes[0]!, lease.leaseId, result(lease, 0, "PASS"))).duplicate).toBe(false);
  });
  it("lost ACK/response and next-day replay keep one canonical receipt, raw row and event", async () => {
    const m = await create(); const e = await scheduled(m.id); const lease = await take(0, e.id); const value = result(lease, 0, "PASS");
    const ack = vi.spyOn(streams, "ack").mockRejectedValueOnce(new Error("simulated Redis ACK loss"));
    let receipt;
    try { receipt = await pipeline.ingest(probes[0]!, lease.leaseId, value); } finally { ack.mockRestore(); }
    // Move only this fixture's receipt to immediately before UTC midnight; no system clock changes.
    const r = (await pool.query("SELECT r.id FROM probe_results r JOIN execution_targets t ON t.id=r.target_id WHERE t.lease_id=$1", [lease.leaseId])).rows[0];
    await pool.query("DELETE FROM check_results WHERE result_id=$1", [r.id]);
    await pool.query("UPDATE probe_results SET received_at=(date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')-interval '1 microsecond' WHERE id=$1", [r.id]);
    await Promise.all([backfillRawHistory(pool, 1000), backfillRawHistory(pool, 1000)]);
    expect((await pipeline.ingest(probes[0]!, lease.leaseId, value)).receiptId).toBe(receipt!.receiptId);
    expect((await pool.query("SELECT count(*)::int AS n FROM check_results WHERE result_id=$1", [r.id])).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM domain_events WHERE envelope->>'type'='probe.result_received' AND envelope->>'correlationId'=$1", [e.id])).rows[0].n).toBe(1);
    expect(await backfillRawHistory(pool, 1000)).toBe(0);
    await expect(pool.query(`INSERT INTO check_results(result_id,organization_id,received_at,result)
      SELECT id,organization_id,received_at+interval '1 day',result FROM probe_results WHERE id=$1`, [r.id])).rejects.toMatchObject({ code: "23503" });
  });
});
