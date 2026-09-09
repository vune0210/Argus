import { ConflictException, ForbiddenException, GoneException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ExecutionDetail, ExecutionSummary, Incident, IncidentDetail, ProbeJob, ProbeLease, ProbeResult, ResultReceipt, EventEnvelope, MonitorSnapshot, RegionSnapshot } from "@argus/contracts";
import { aggregate, reduceHealth, type HealthState } from "@argus/domain";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Pool, PoolClient } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { OrganizationsService } from "../organizations/organizations.service";
import { DOMAIN_STREAM, jobStream, RedisStreams } from "./redis-streams";
import type { ProbeIdentity } from "./probe-auth";
import { PipelineMetrics } from "./metrics";

// Rows stay internal; every public response is mapped to the v0.2 camelCase contract.
interface ExecutionRow {
  id: string; organization_id: string; monitor_id: string; monitor_version: number; sequence: string;
  kind: ExecutionSummary["kind"]; status: ExecutionSummary["status"]; scheduled_at: Date; deadline_at: Date;
  completed_at: Date | null; observation: ExecutionSummary["observation"]; config: ProbeJob["config"];
  idempotency_key?: string | null;
}
interface MonitorRow {
  id: string; organization_id: string; version: number; config: ProbeJob["config"]; regions: string[];
  health_state: HealthState; last_evaluated_sequence: string; flapping_until: Date | null; deleted_at: Date | null;
  consecutive_failures: number; consecutive_passes: number; failure_threshold: number; recovery_threshold: number;
}
const summary = (r: ExecutionRow): ExecutionSummary => ({ id: r.id, organizationId: r.organization_id, monitorId: r.monitor_id,
  monitorVersion: r.monitor_version, kind: r.kind, status: r.status, scheduledAt: r.scheduled_at.toISOString(),
  deadlineAt: r.deadline_at.toISOString(), completedAt: r.completed_at?.toISOString() ?? null, observation: r.observation });
const incident = (r: {
  id: string;
  organization_id: string;
  monitor_id: string;
  status?: Incident["status"];
  opened_at: Date;
  acknowledged_at?: Date | null;
  acknowledged_by?: string | null;
  resolved_at: Date | null;
  resolved_by?: string | null;
}): Incident => ({
  id: r.id,
  organizationId: r.organization_id,
  monitorId: r.monitor_id,
  status: r.status ?? (r.resolved_at ? "RESOLVED" : "OPEN"),
  openedAt: r.opened_at.toISOString(),
  acknowledgedAt: r.acknowledged_at?.toISOString() ?? null,
  acknowledgedBy: r.acknowledged_by ?? null,
  resolvedAt: r.resolved_at?.toISOString() ?? null,
  resolvedBy: r.resolved_by ?? null,
});

@Injectable()
export class PipelineService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
    @Inject(RedisStreams) private readonly streams: RedisStreams,
    @Inject(PipelineMetrics) private readonly metrics: PipelineMetrics = new PipelineMetrics()) {}

  async transaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query("BEGIN"); const result = await fn(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  private async createExecution(client: PoolClient, monitor: MonitorRow, kind: ExecutionSummary["kind"], idempotencyKey?: string): Promise<ExecutionSummary> {
    const result = await client.query<ExecutionRow>(`INSERT INTO executions(organization_id,monitor_id,monitor_version,kind,scheduled_at,deadline_at,config,idempotency_key)
      VALUES($1,$2,$3,$4,clock_timestamp(),clock_timestamp()+interval '150 seconds',$5,$6) RETURNING *`,
    [monitor.organization_id, monitor.id, monitor.version, kind, monitor.config, idempotencyKey ?? null]);
    const execution = result.rows[0]!;
    await client.query(`WITH targets AS (
      INSERT INTO execution_targets(organization_id,execution_id,region) SELECT $1,$2,unnest($3::text[]) RETURNING *
    ) INSERT INTO outbox_events(organization_id,dedup_key,stream,payload)
      SELECT organization_id,'target:'||id,'argus:v1:probe-jobs:'||region,jsonb_build_object('targetId',id) FROM targets`,
    [monitor.organization_id, execution.id, monitor.regions]);
    return summary(execution);
  }

  async schedule(limit = 100): Promise<number> {
    return this.transaction(async (client) => {
      const due = await client.query<MonitorRow>(`SELECT * FROM monitors WHERE deleted_at IS NULL AND next_run_at<=now()
        ORDER BY next_run_at,id LIMIT $1 FOR UPDATE SKIP LOCKED`, [limit]);
      for (const monitor of due.rows) {
        await this.createExecution(client, monitor, "SCHEDULED");
        await client.query("UPDATE monitors SET next_run_at=clock_timestamp()+interval_seconds*interval '1 second' WHERE id=$1", [monitor.id]);
      }
      return due.rows.length;
    });
  }

  async run(organizationId: string, userId: string, id: string): Promise<ExecutionSummary> {
    const role = await this.organizations.membership(organizationId, userId);
    if (role === "VIEWER") throw new ForbiddenException("Responder role or higher is required");
    return this.transaction(async (client) => {
      const monitor = await client.query<MonitorRow>("SELECT * FROM monitors WHERE id=$1 AND organization_id=$2 AND deleted_at IS NULL FOR UPDATE", [id, organizationId]);
      if (!monitor.rows[0]) throw new NotFoundException("Monitor not found");
      return this.createExecution(client, monitor.rows[0], "MANUAL");
    });
  }

  async evaluate(organizationId: string, userId: string, id: string, idempotencyKey: string, monitorVersion: number): Promise<ExecutionSummary> {
    const role = await this.organizations.membership(organizationId, userId);
    if (role === "VIEWER") throw new ForbiddenException("Responder role or higher is required");
    return this.transaction(async (client) => {
      const existing = await client.query<ExecutionRow>(
        "SELECT * FROM executions WHERE organization_id = $1 AND monitor_id = $2 AND idempotency_key = $3 AND kind = 'EVALUATION'",
        [organizationId, id, idempotencyKey],
      );
      if (existing.rows[0]) {
        return summary(existing.rows[0]);
      }
      const monitor = await client.query<MonitorRow>(
        "SELECT * FROM monitors WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE",
        [id, organizationId],
      );
      if (!monitor.rows[0]) throw new NotFoundException("Monitor not found");
      const m = monitor.rows[0];
      if (monitorVersion !== m.version) {
        throw new ConflictException({
          code: "VERSION_CONFLICT",
          message: "Monitor was changed by another request",
          details: { currentVersion: m.version },
        });
      }
      return this.createExecution(client, m, "EVALUATION", idempotencyKey);
    });
  }
  async executions(organizationId: string, userId: string, id: string): Promise<{ items: ExecutionSummary[] }> {
    await this.organizations.membership(organizationId, userId);
    const exists = await this.pool.query("SELECT 1 FROM monitors WHERE id=$1 AND organization_id=$2", [id, organizationId]);
    if (!exists.rowCount) throw new NotFoundException("Monitor not found");
    const result = await this.pool.query<ExecutionRow>("SELECT * FROM executions WHERE monitor_id=$1 AND organization_id=$2 ORDER BY sequence DESC LIMIT 100", [id, organizationId]);
    return { items: result.rows.map(summary) };
  }
  async execution(organizationId: string, userId: string, id: string): Promise<ExecutionDetail> {
    await this.organizations.membership(organizationId, userId);
    const result = await this.pool.query<ExecutionRow>("SELECT * FROM executions WHERE id=$1 AND organization_id=$2", [id, organizationId]);
    if (!result.rows[0]) throw new NotFoundException("Execution not found");
    const targets = await this.pool.query(`SELECT t.id,t.region,t.status,t.attempts,r.result FROM execution_targets t
      LEFT JOIN probe_results r ON r.target_id=t.id AND r.organization_id=t.organization_id WHERE t.execution_id=$1 AND t.organization_id=$2 ORDER BY t.region`, [id, organizationId]);
    return { ...summary(result.rows[0]), targets: targets.rows };
  }
  async snapshot(organizationId: string, userId: string, id: string): Promise<MonitorSnapshot> {
    await this.organizations.membership(organizationId, userId);
    // One statement gives health, config, results and heartbeat a consistent database snapshot.
    // Probe visibility is limited to assignments for THIS tenant/monitor, never the global fleet.
    const query = await this.pool.query(`SELECT m.version,m.health_state,m.interval_seconds,now() AS observed_at,
      region.name AS region,r.execution_id,r.sequence,r.scheduled_at,r.result,r.received_at,p.last_seen_at,p.status AS probe_status
      FROM monitors m CROSS JOIN LATERAL unnest(m.regions) WITH ORDINALITY AS region(name,position)
      LEFT JOIN LATERAL (
        SELECT e.id AS execution_id,e.sequence::text,e.scheduled_at,pr.result,pr.received_at
        FROM executions e JOIN execution_targets t ON t.execution_id=e.id AND t.organization_id=e.organization_id
        JOIN probe_results pr ON pr.target_id=t.id AND pr.organization_id=t.organization_id
        WHERE e.monitor_id=m.id AND e.organization_id=m.organization_id AND e.monitor_version=m.version
          AND e.kind='SCHEDULED' AND t.region=region.name
        ORDER BY e.sequence DESC LIMIT 1
      ) r ON true
      LEFT JOIN LATERAL (
        SELECT pa.last_seen_at,pa.status FROM executions e
        JOIN execution_targets t ON t.execution_id=e.id AND t.organization_id=e.organization_id
        JOIN probe_agents pa ON pa.id=t.probe_id AND pa.region=t.region
        WHERE e.monitor_id=m.id AND e.organization_id=m.organization_id AND t.region=region.name
        ORDER BY e.sequence DESC LIMIT 1
      ) p ON true
      WHERE m.id=$1 AND m.organization_id=$2 AND m.deleted_at IS NULL ORDER BY region.position`, [id, organizationId]);
    const first = query.rows[0];
    if (!first) throw new NotFoundException("Monitor not found");
    const observedAt = first.observed_at as Date;
    const regions: RegionSnapshot[] = query.rows.map((row) => {
      const result = row.result as ProbeResult | null;
      const seen = row.last_seen_at as Date | null;
      return {
        region: row.region, executionId: row.execution_id ?? null, executionSequence: row.sequence ?? null,
        outcome: result?.outcome ?? null, latencyMs: result?.durationMs ?? null,
        completedAt: result?.completedAt ?? null, receivedAt: row.received_at?.toISOString() ?? null,
        freshness: !result ? "NO_DATA" : observedAt.getTime() > row.scheduled_at.getTime() + row.interval_seconds * 1000 + 150_000 ? "STALE" : "FRESH",
        heartbeat: { status: !seen ? "UNKNOWN" : row.probe_status === "ACTIVE" && observedAt.getTime() - seen.getTime() <= 60_000 ? "ALIVE" : "STALE",
          lastSeenAt: seen?.toISOString() ?? null },
      };
    });
    return { organizationId, monitorId: id, monitorVersion: first.version, healthState: first.health_state,
      observedAt: observedAt.toISOString(), regions };
  }
  private mapIncidentDetail(
    row: {
      id: string;
      organization_id: string;
      monitor_id: string;
      status?: Incident["status"];
      opened_at: Date;
      acknowledged_at?: Date | null;
      acknowledged_by?: string | null;
      resolved_at: Date | null;
      resolved_by?: string | null;
    },
    eventsRows: Array<{ id: string; execution_id?: string | null; type: "OPENED" | "ACKNOWLEDGED" | "RESOLVED"; occurred_at: Date; actor?: string | null }>,
    deliveriesRows: Array<{
      id: string;
      incident_id: string;
      escalation_step_id?: string | null;
      channel_id: string;
      event_kind?: "INCIDENT_OPENED" | "INCIDENT_RESOLVED";
      status: "PENDING" | "SENDING" | "SENT" | "FAILED" | "CANCELED";
      attempts: number;
      scheduled_at: Date;
      next_attempt_at: Date;
      last_attempted_at?: Date | null;
      last_error?: string | null;
    }>,
  ): IncidentDetail {
    return {
      ...incident(row),
      events: eventsRows.map((e) => ({
        id: e.id,
        executionId: e.execution_id ?? null,
        type: e.type,
        occurredAt: e.occurred_at.toISOString(),
        actor: e.actor ?? null,
      })),
      deliveries: deliveriesRows.map((d) => ({
        id: d.id,
        incidentId: d.incident_id,
        escalationStepId: d.escalation_step_id ?? null,
        channelId: d.channel_id,
        eventKind: (d.event_kind || "INCIDENT_OPENED") as "INCIDENT_OPENED" | "INCIDENT_RESOLVED",
        status: d.status,
        attempts: d.attempts,
        scheduledAt: d.scheduled_at.toISOString(),
        nextAttemptAt: d.next_attempt_at.toISOString(),
        lastAttemptedAt: d.last_attempted_at?.toISOString() ?? null,
        lastError: d.last_error ?? null,
      })),
    };
  }

  private async fetchIncidentDetail(client: Pool | PoolClient, organizationId: string, id: string): Promise<IncidentDetail> {
    const result = await client.query("SELECT * FROM incidents WHERE id=$1 AND organization_id=$2", [id, organizationId]);
    if (!result.rows[0]) throw new NotFoundException({ code: "INCIDENT_NOT_FOUND", message: "Incident not found" });
    const events = await client.query("SELECT * FROM incident_events WHERE incident_id=$1 AND organization_id=$2 ORDER BY occurred_at,id", [id, organizationId]);
    const deliveries = await client.query("SELECT * FROM notification_deliveries WHERE incident_id=$1 AND organization_id=$2 ORDER BY scheduled_at,id", [id, organizationId]);
    return this.mapIncidentDetail(result.rows[0], events.rows, deliveries.rows);
  }

  async incidents(organizationId: string, userId: string): Promise<{ items: Incident[] }> {
    await this.organizations.membership(organizationId, userId);
    const result = await this.pool.query("SELECT * FROM incidents WHERE organization_id=$1 ORDER BY opened_at DESC,id DESC LIMIT 100", [organizationId]);
    return { items: result.rows.map(incident) };
  }

  async incident(organizationId: string, userId: string, id: string): Promise<IncidentDetail> {
    await this.organizations.membership(organizationId, userId);
    return this.fetchIncidentDetail(this.pool, organizationId, id);
  }

  async ackIncident(organizationId: string, userId: string, incidentId: string): Promise<IncidentDetail> {
    await this.organizations.requireIncidentWrite(organizationId, userId);
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM incidents WHERE id=$1 AND organization_id=$2 FOR UPDATE", [incidentId, organizationId])).rows[0];
      if (!row) throw new NotFoundException({ code: "INCIDENT_NOT_FOUND", message: "Incident not found" });
      if (row.status === "RESOLVED") {
        throw new ConflictException({ code: "INCIDENT_ALREADY_RESOLVED", message: "Incident is already resolved" });
      }
      if (row.status === "ACKNOWLEDGED") {
        return this.fetchIncidentDetail(client, organizationId, incidentId);
      }
      const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
      await client.query("UPDATE incidents SET status='ACKNOWLEDGED', acknowledged_at=$2, acknowledged_by=$3 WHERE id=$1", [incidentId, now, userId]);
      await client.query("INSERT INTO incident_events(organization_id,incident_id,type,occurred_at,actor) VALUES($1,$2,'ACKNOWLEDGED',$3,$4)", [organizationId, incidentId, now, userId]);
      const canceled = await client.query(
        "UPDATE notification_deliveries SET status='CANCELED' WHERE incident_id=$1 AND status='PENDING' AND event_kind='INCIDENT_OPENED' RETURNING id, organization_id, incident_id, event_kind",
        [incidentId],
      );
      for (const d of (canceled?.rows || [])) {
        await this.event(client, organizationId, "notification.canceled", incidentId, {
          deliveryId: d.id,
          incidentId: d.incident_id,
          reason: "incident_acknowledged",
          eventKind: d.event_kind,
        });
      }
      await this.event(client, organizationId, "incident.acknowledged", incidentId, { incidentId, monitorId: row.monitor_id, acknowledgedBy: userId, acknowledgedAt: now.toISOString() });
      return this.fetchIncidentDetail(client, organizationId, incidentId);
    });
  }

  async resolveIncident(organizationId: string, userId: string, incidentId: string): Promise<IncidentDetail> {
    await this.organizations.requireIncidentWrite(organizationId, userId);
    return this.transaction(async (client) => {
      const row = (await client.query("SELECT * FROM incidents WHERE id=$1 AND organization_id=$2 FOR UPDATE", [incidentId, organizationId])).rows[0];
      if (!row) throw new NotFoundException({ code: "INCIDENT_NOT_FOUND", message: "Incident not found" });
      if (row.status === "RESOLVED") {
        return this.fetchIncidentDetail(client, organizationId, incidentId);
      }
      const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
      await client.query("UPDATE incidents SET status='RESOLVED', resolved_at=$2, resolved_by=$3 WHERE id=$1", [incidentId, now, userId]);
      await client.query("INSERT INTO incident_events(organization_id,incident_id,type,occurred_at,actor) VALUES($1,$2,'RESOLVED',$3,$4)", [organizationId, incidentId, now, userId]);
      const canceled = await client.query(
        "UPDATE notification_deliveries SET status='CANCELED' WHERE incident_id=$1 AND status='PENDING' AND event_kind='INCIDENT_OPENED' RETURNING id, organization_id, incident_id, event_kind",
        [incidentId],
      );
      for (const d of (canceled?.rows || [])) {
        await this.event(client, organizationId, "notification.canceled", incidentId, {
          deliveryId: d.id,
          incidentId: d.incident_id,
          reason: "incident_resolved",
          eventKind: d.event_kind,
        });
      }
      await this.event(client, organizationId, "incident.resolved", incidentId, { incidentId, monitorId: row.monitor_id, resolvedBy: userId, resolvedAt: now.toISOString(), manual: true });
      await this.createRecoveryDeliveries(client, organizationId, incidentId, now);
      return this.fetchIncidentDetail(client, organizationId, incidentId);
    });
  }

  async dispatch(limit = 100): Promise<number> {
    return this.transaction(async (client) => {
      const pending = await client.query("SELECT * FROM outbox_events WHERE published_at IS NULL ORDER BY created_at,id LIMIT $1 FOR UPDATE SKIP LOCKED", [limit]);
      for (const event of pending.rows) {
        const streamId = await this.streams.publish(event.stream, event.payload);
        await client.query("UPDATE outbox_events SET published_at=now() WHERE id=$1", [event.id]);
        if (event.payload.targetId) await client.query("UPDATE execution_targets SET published_at=now(),stream_id=$2 WHERE id=$1 AND status='QUEUED'", [event.payload.targetId, streamId]);
      }
      return pending.rows.length;
    });
  }

  /** Repair a lost Redis stream from durable targets, including Redis data loss. */
  async repair(): Promise<void> {
    await this.pool.query(`UPDATE outbox_events o SET published_at=NULL FROM execution_targets t,executions e
      WHERE o.dedup_key='target:'||t.id AND t.execution_id=e.id AND e.completed_at IS NULL AND e.deadline_at>now()
      AND o.published_at<now()-interval '45 seconds'
      AND (t.status='QUEUED' OR (t.status='LEASED' AND t.lease_expires_at<now()))`);
  }

  async lease(probe: ProbeIdentity): Promise<ProbeLease | null> {
    const entry = await this.streams.take(probe.region, probe.id);
    if (!entry) return null;
    let targetId: string;
    try {
      targetId = JSON.parse(entry.payload).targetId;
      if (typeof targetId !== "string" || !/^[a-f0-9-]{36}$/i.test(targetId)) throw new Error();
    } catch {
      await this.streams.publish(`${jobStream(probe.region)}:dlq`, { streamId: entry.id, reason: "INVALID_JOB" });
      await this.streams.ack(probe.region, entry.id);
      return null;
    }
    let ack = false;
    const lease = await this.transaction(async (client) => {
      // Consistent locking order: execution -> target. Aggregators use monitor -> execution -> targets.
      const lookup = await client.query("SELECT execution_id FROM execution_targets WHERE id=$1 AND region=$2", [targetId, probe.region]);
      if (!lookup.rows[0]) { ack = true; return null; }
      const execution = (await client.query<ExecutionRow>("SELECT * FROM executions WHERE id=$1 FOR UPDATE", [lookup.rows[0].execution_id])).rows[0]!;
      const target = (await client.query("SELECT * FROM execution_targets WHERE id=$1 FOR UPDATE", [targetId])).rows[0]!;
      if (execution.completed_at || ["COMPLETED", "DEAD", "EXPIRED"].includes(target.status)) { ack = true; return null; }
      const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
      if (execution.deadline_at <= now) { ack = true; return null; }
      if (target.status === "LEASED" && target.lease_expires_at > now) return null;
      if (target.attempts >= 3) {
        await client.query("UPDATE execution_targets SET status='DEAD' WHERE id=$1", [targetId]);
        await client.query(`INSERT INTO outbox_events(organization_id,dedup_key,stream,payload) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
          [execution.organization_id, `dlq:${targetId}`, `${jobStream(probe.region)}:dlq`, { targetId, reason: "MAX_ATTEMPTS" }]);
        ack = true; return null;
      }
      const leaseId = randomUUID();
      const expiresAt = new Date(Math.min(now.getTime() + 45_000, execution.deadline_at.getTime())).toISOString();
      await client.query(`UPDATE execution_targets SET status='LEASED',attempts=attempts+1,lease_id=$2,probe_id=$3,
        lease_expires_at=$4,stream_id=$5 WHERE id=$1`, [targetId, leaseId, probe.id, expiresAt, entry.id]);
      await client.query("UPDATE executions SET status='RUNNING' WHERE id=$1", [execution.id]);
      const jobSchemaVersion = (execution.config?.kind === "http" ? "0.1" : "0.2") as "0.1" | "0.2";
      return { leaseId, expiresAt, targetRegion: probe.region, job: { schemaVersion: jobSchemaVersion, executionId: execution.id,
        organizationId: execution.organization_id, monitorId: execution.monitor_id, monitorVersion: execution.monitor_version,
        scheduledAt: execution.scheduled_at.toISOString(), deadlineAt: execution.deadline_at.toISOString(), config: execution.config } };
    });
    if (ack) await this.streams.ack(probe.region, entry.id);
    return lease;
  }

  async heartbeat(probe: ProbeIdentity, leaseId: string): Promise<{ expiresAt: string }> {
    const result = await this.pool.query(`UPDATE execution_targets t SET lease_expires_at=LEAST(clock_timestamp()+interval '45 seconds', e.deadline_at)
      FROM executions e WHERE t.execution_id=e.id AND t.lease_id=$1 AND t.probe_id=$2 AND t.region=$3
      AND t.status='LEASED' AND t.lease_expires_at>clock_timestamp() AND e.completed_at IS NULL AND e.deadline_at>clock_timestamp()
      RETURNING t.lease_expires_at`, [leaseId, probe.id, probe.region]);
    if (!result.rows[0]) throw new GoneException("Lease expired or no longer owned by this probe");
    return { expiresAt: result.rows[0].lease_expires_at.toISOString() };
  }

  async ingest(probe: ProbeIdentity, leaseId: string, result: ProbeResult): Promise<ResultReceipt> {
    const started = Date.now();
    let streamId: string | null = null;
    const receipt = await this.transaction(async (client) => {
      const lookup = await client.query("SELECT execution_id FROM execution_targets WHERE lease_id=$1 AND probe_id=$2 AND region=$3", [leaseId, probe.id, probe.region]);
      if (!lookup.rows[0]) throw new GoneException("Lease expired or no longer owned by this probe");
      const e = (await client.query<ExecutionRow>("SELECT * FROM executions WHERE id=$1 FOR UPDATE", [lookup.rows[0].execution_id])).rows[0]!;
      const t = (await client.query("SELECT * FROM execution_targets WHERE lease_id=$1 FOR UPDATE", [leaseId])).rows[0];
      if (!t || t.probe_id !== probe.id || t.region !== probe.region) throw new GoneException("Lease ownership changed");
      if (result.executionId !== e.id || result.organizationId !== e.organization_id || result.monitorId !== e.monitor_id
        || result.monitorVersion !== e.monitor_version || result.probeId !== probe.id || result.region !== probe.region) {
        throw new ConflictException("Result identity does not match the leased job");
      }
      const kind = e.config?.kind;
      if (kind === "http" && (result.tcp || result.ssl || result.keyword)) {
        throw new ConflictException("Result kind mismatch: expected http");
      }
      if (kind === "tcp" && (result.http || result.ssl || result.keyword)) {
        throw new ConflictException("Result kind mismatch: expected tcp");
      }
      if (kind === "ssl" && (result.http || result.tcp || result.keyword)) {
        throw new ConflictException("Result kind mismatch: expected ssl");
      }
      if (kind === "keyword" && (result.http || result.tcp || result.ssl)) {
        throw new ConflictException("Result kind mismatch: expected keyword");
      }
      streamId = t.stream_id;
      const existing = (await client.query("SELECT * FROM probe_results WHERE target_id=$1", [t.id])).rows[0];
      if (existing) {
        if (!isDeepStrictEqual(existing.result, result)) throw new ConflictException("Conflicting duplicate result");
        return { receiptId: existing.receipt_id, receivedAt: existing.received_at.toISOString(), duplicate: true };
      }
      const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
      if (e.completed_at || e.deadline_at <= now || t.lease_expires_at <= now || t.status !== "LEASED") throw new GoneException("Lease expired");
      if (Date.parse(result.startedAt) < e.scheduled_at.getTime() - 1000 || Date.parse(result.completedAt) > now.getTime() + 5000) throw new ConflictException("Result timestamps are outside the execution window");
      const saved = (await client.query("INSERT INTO probe_results(organization_id,target_id,result) VALUES($1,$2,$3) RETURNING *", [e.organization_id, t.id, result])).rows[0];
      // Exact canonical timestamp (including PostgreSQL microseconds) anchors the raw copy.
      await client.query(`INSERT INTO check_results(result_id,organization_id,received_at,result)
        SELECT id,organization_id,received_at,result FROM probe_results WHERE id=$1`, [saved.id]);
      await client.query("UPDATE execution_targets SET status='COMPLETED' WHERE id=$1", [t.id]);
      await this.event(client, e.organization_id, "probe.result_received", e.id, { executionId: e.id, monitorId: e.monitor_id, region: t.region });
      return { receiptId: saved.receipt_id, receivedAt: saved.received_at.toISOString(), duplicate: false };
    });
    // Commit is complete. Failed ACK is repaired by redelivery; it must not undo a durable receipt.
    if (streamId) await this.streams.ack(probe.region, streamId).catch(() => undefined);
    this.metrics.observe("result_ingestion", (Date.now() - started) / 1000);
    this.metrics.increment(receipt.duplicate ? "result_duplicate" : "result_accepted");
    return receipt;
  }

  private async event(client: PoolClient, organizationId: string, type: string, executionId: string, payload: unknown): Promise<void> {
    // Serialize allocation per tenant, so replay sequence is also commit order.
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 1))", [organizationId]);
    const envelope: EventEnvelope = { id: randomUUID(), type, version: 1, occurredAt: new Date().toISOString(), organizationId, correlationId: executionId, payload };
    await client.query("INSERT INTO domain_events(id,organization_id,envelope) VALUES($1,$2,$3)", [envelope.id, organizationId, envelope]);
    await client.query("INSERT INTO outbox_events(organization_id,dedup_key,stream,payload) VALUES($1,$2,$3,$4)", [organizationId, `event:${envelope.id}`, DOMAIN_STREAM, envelope]);
  }

  async finalize(limit = 100): Promise<number> {
    const candidates = await this.pool.query(`SELECT e.id,e.monitor_id FROM executions e WHERE e.completed_at IS NULL AND
      (e.deadline_at<=now() OR NOT EXISTS(SELECT 1 FROM execution_targets t WHERE t.execution_id=e.id AND t.status IN ('QUEUED','LEASED')))
      ORDER BY e.sequence LIMIT $1`, [limit]);
    let count = 0;
    for (const candidate of candidates.rows) {
      const finalized = await this.transaction(async (client) => {
        const m = (await client.query<MonitorRow>("SELECT * FROM monitors WHERE id=$1 FOR UPDATE SKIP LOCKED", [candidate.monitor_id])).rows[0];
        if (!m) return false;
        const e = (await client.query<ExecutionRow>("SELECT * FROM executions WHERE id=$1 FOR UPDATE", [candidate.id])).rows[0]!;
        if (e.completed_at) return false;
        const now = (await client.query("SELECT clock_timestamp() AS time")).rows[0].time as Date;
        const targets = await client.query(`SELECT t.status,r.result FROM execution_targets t LEFT JOIN probe_results r ON r.target_id=t.id WHERE t.execution_id=$1`, [e.id]);
        if (e.deadline_at > now && targets.rows.some((t) => ["QUEUED", "LEASED"].includes(t.status))) return false;
        const observation = aggregate(targets.rows.map((t) => t.result?.outcome ?? null));
        await client.query("UPDATE execution_targets SET status='EXPIRED' WHERE execution_id=$1 AND status IN ('QUEUED','LEASED')", [e.id]);
        await client.query("UPDATE executions SET status='COMPLETED',observation=$2,completed_at=$3 WHERE id=$1", [e.id, observation, now]);
        const transitions = await client.query("SELECT occurred_at FROM monitor_state_transitions WHERE monitor_id=$1 AND occurred_at>=$2", [m.id, new Date(now.getTime() - 600_000)]);
        const reduction = reduceHealth({
          state: m.health_state, observation, kind: e.kind, sequence: Number(e.sequence), lastSequence: Number(m.last_evaluated_sequence),
          currentVersion: m.version, executionVersion: e.monitor_version, flappingUntil: m.flapping_until?.getTime() ?? null,
          recentTransitions: transitions.rows.map((r) => r.occurred_at.getTime()),
          consecutiveFailures: m.consecutive_failures, consecutivePasses: m.consecutive_passes,
          failureThreshold: m.failure_threshold ?? 2, recoveryThreshold: m.recovery_threshold ?? 2,
        }, now.getTime());
        if (reduction.applied && !m.deleted_at) {
          await client.query(`UPDATE monitors SET health_state=$2,last_evaluated_execution_id=$3,last_evaluated_sequence=$4,flapping_until=$5,
            consecutive_failures=$6,consecutive_passes=$7,updated_at=$8 WHERE id=$1`,
          [m.id, reduction.state, e.id, e.sequence, reduction.flappingUntil ? new Date(reduction.flappingUntil) : null,
           reduction.consecutiveFailures, reduction.consecutivePasses, now]);
          if (reduction.changed) {
            await client.query(`INSERT INTO monitor_state_transitions(organization_id,monitor_id,execution_id,from_state,to_state,observation,occurred_at)
              VALUES($1,$2,$3,$4,$5,$6,$7)`, [m.organization_id, m.id, e.id, m.health_state, reduction.state, observation, now]);
            await this.event(client, m.organization_id, "monitor.health_changed", e.id, { monitorId: m.id, from: m.health_state, to: reduction.state });
          }
          if (reduction.openIncident) {
            const opened = await client.query(
              `INSERT INTO incidents(organization_id,monitor_id,opened_at,status) VALUES($1,$2,$3,'OPEN')
               ON CONFLICT(monitor_id) WHERE status != 'RESOLVED' DO NOTHING RETURNING id`,
              [m.organization_id, m.id, now],
            );
            if (opened.rows[0]) {
              await this.incidentEvent(client, m, e.id, opened.rows[0].id, "OPENED", now);
              await this.createIncidentDeliveries(client, m.organization_id, opened.rows[0].id, now);
            }
          }
          if (reduction.resolveIncident) {
            const resolved = await client.query(
              "UPDATE incidents SET status='RESOLVED', resolved_at=$2, resolved_by=NULL WHERE monitor_id=$1 AND status IN ('OPEN', 'ACKNOWLEDGED') RETURNING id",
              [m.id, now],
            );
            if (resolved.rows[0]) {
              const resId = resolved.rows[0].id;
              const canceled = await client.query(
                "UPDATE notification_deliveries SET status='CANCELED' WHERE incident_id=$1 AND status='PENDING' AND event_kind='INCIDENT_OPENED' RETURNING id, organization_id, incident_id, event_kind",
                [resId],
              );
              for (const d of canceled.rows) {
                await this.event(client, m.organization_id, "notification.canceled", resId, {
                  deliveryId: d.id,
                  incidentId: d.incident_id,
                  reason: "incident_resolved",
                  eventKind: d.event_kind,
                });
              }
              await this.incidentEvent(client, m, e.id, resId, "RESOLVED", now);
              await this.createRecoveryDeliveries(client, m.organization_id, resId, now);
            }
          }
        }
        await this.event(client, m.organization_id, "execution.completed", e.id, { executionId: e.id, monitorId: m.id, observation, kind: e.kind });
        return true;
      });
      if (finalized) count++;
    }
    return count;
  }

  private async createIncidentDeliveries(client: PoolClient, organizationId: string, incidentId: string, now: Date): Promise<number> {
    try {
      const stepsRes = await client.query(
        `SELECT s.id AS step_id, s.step_order, s.delay_seconds,
                COALESCE(sc.channel_id, s.channel_id) AS channel_id,
                c.enabled
         FROM escalation_policies p
         JOIN escalation_policy_steps s ON s.policy_id = p.id AND s.organization_id = p.organization_id
         LEFT JOIN escalation_step_channels sc ON sc.step_id = s.id
         JOIN notification_channels c ON c.id = COALESCE(sc.channel_id, s.channel_id) AND c.organization_id = s.organization_id
         WHERE p.organization_id = $1 AND c.enabled = true
         ORDER BY s.step_order ASC, c.created_at ASC`,
        [organizationId],
      );

      if (!stepsRes.rowCount) {
        this.metrics.increment("notification_configuration_missing");
        return 0;
      }

      let count = 0;
      for (const step of stepsRes.rows) {
        const scheduledAt = new Date(now.getTime() + step.delay_seconds * 1000);
        const deliveryRes = await client.query(
          `INSERT INTO notification_deliveries(
             organization_id, incident_id, escalation_step_id, channel_id, event_kind, status, attempts, scheduled_at, next_attempt_at
           ) VALUES ($1, $2, $3, $4, 'INCIDENT_OPENED', 'PENDING', 0, $5, $5)
           ON CONFLICT (incident_id, escalation_step_id, channel_id) WHERE event_kind = 'INCIDENT_OPENED' DO NOTHING
           RETURNING id`,
          [organizationId, incidentId, step.step_id, step.channel_id, scheduledAt],
        );

        if (deliveryRes.rows[0]) {
          count++;
          const deliveryId = deliveryRes.rows[0].id;
          await this.event(client, organizationId, "notification.queued", incidentId, {
            deliveryId,
            incidentId,
            channelId: step.channel_id,
            scheduledAt: scheduledAt.toISOString(),
            eventKind: "INCIDENT_OPENED",
          });
        }
      }
      return count;
    } catch {
      this.metrics.increment("notification_configuration_missing");
      return 0;
    }
  }

  private async createRecoveryDeliveries(client: PoolClient, organizationId: string, incidentId: string, now: Date): Promise<number> {
    try {
      const primaryChannelsRes = await client.query(
        `SELECT s.id AS step_id,
                COALESCE(sc.channel_id, s.channel_id) AS channel_id,
                c.enabled
         FROM escalation_policies p
         JOIN escalation_policy_steps s ON s.policy_id = p.id AND s.organization_id = p.organization_id
         LEFT JOIN escalation_step_channels sc ON sc.step_id = s.id
         JOIN notification_channels c ON c.id = COALESCE(sc.channel_id, s.channel_id) AND c.organization_id = s.organization_id
         WHERE p.organization_id = $1 AND s.step_order = 0 AND c.enabled = true
         ORDER BY c.created_at ASC`,
        [organizationId],
      );

      if (!primaryChannelsRes?.rowCount || !Array.isArray(primaryChannelsRes.rows)) {
        return 0;
      }

      let count = 0;
      for (const row of primaryChannelsRes.rows) {
        const deliveryRes = await client.query(
          `INSERT INTO notification_deliveries(
             organization_id, incident_id, escalation_step_id, channel_id, event_kind, status, attempts, scheduled_at, next_attempt_at
           ) VALUES ($1, $2, $3, $4, 'INCIDENT_RESOLVED', 'PENDING', 0, $5, $5)
           ON CONFLICT (incident_id, channel_id) WHERE event_kind = 'INCIDENT_RESOLVED' DO NOTHING
           RETURNING id`,
          [organizationId, incidentId, row.step_id, row.channel_id, now],
        );

        if (deliveryRes.rows[0]) {
          count++;
          const deliveryId = deliveryRes.rows[0].id;
          await this.event(client, organizationId, "notification.queued", incidentId, {
            deliveryId,
            incidentId,
            channelId: row.channel_id,
            scheduledAt: now.toISOString(),
            eventKind: "INCIDENT_RESOLVED",
          });
        }
      }
      return count;
    } catch {
      return 0;
    }
  }

  private async incidentEvent(client: PoolClient, m: MonitorRow, executionId: string, incidentId: string, type: "OPENED" | "RESOLVED", now: Date): Promise<void> {
    await client.query("INSERT INTO incident_events(organization_id,incident_id,execution_id,type,occurred_at) VALUES($1,$2,$3,$4,$5)", [m.organization_id, incidentId, executionId, type, now]);
    await this.event(client, m.organization_id, type === "OPENED" ? "incident.opened" : "incident.resolved", executionId, { incidentId, monitorId: m.id });
  }

  async gauges(): Promise<Record<string, number>> {
    const row = (await this.pool.query(`SELECT
      (SELECT count(*)::int FROM execution_targets WHERE status IN ('QUEUED','LEASED')) AS queue_depth,
      (SELECT count(*)::int FROM outbox_events WHERE published_at IS NULL) AS outbox_depth,
      (SELECT COALESCE(max(extract(epoch FROM now()-next_run_at)),0)::float FROM monitors WHERE deleted_at IS NULL AND next_run_at<=now()) AS scheduler_lag_seconds,
      (SELECT count(*)::int FROM incident_events WHERE type='OPENED') AS incidents_opened_total,
      (SELECT count(*)::int FROM incident_events WHERE type='RESOLVED') AS incidents_resolved_total,
      (SELECT count(*)::int FROM probe_agents WHERE status = 'ACTIVE' AND (last_seen_at IS NULL OR last_seen_at < now() - interval '60 seconds')) AS stale_probes_count,
      (SELECT count(*)::int FROM notification_deliveries WHERE status = 'FAILED') AS notification_failures_total,
      (SELECT count(*)::int FROM notification_deliveries WHERE attempts > 1) AS notification_retries_total`)).rows[0];
    return row;
  }
}
