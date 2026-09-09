import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { Monitor } from "@argus/contracts";
import type { Pool, PoolClient } from "pg";
import { DATABASE_POOL } from "../database/database.module";
import { OrganizationsService } from "../organizations/organizations.service";
import type { MonitorInput, MonitorUpdateInput } from "./monitor.validation";

interface MonitorRow {
  id: string;
  organization_id: string;
  name: string;
  interval_seconds: number;
  regions: string[];
  health_state: Monitor["healthState"];
  version: number;
  config: Monitor["config"];
  failure_threshold: number;
  recovery_threshold: number;
  created_at: Date | string;
  updated_at: Date | string;
  created_by: string;
  updated_by: string;
}

function toMonitor(row: MonitorRow): Monitor {
  return {
    id: row.id,
    organizationId: row.organization_id,
    name: row.name,
    intervalSeconds: row.interval_seconds,
    regions: row.regions,
    healthState: row.health_state,
    version: row.version,
    config: row.config,
    incidentPolicy: {
      failureThreshold: row.failure_threshold ?? 2,
      recoveryThreshold: row.recovery_threshold ?? 2,
    },
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
  };
}

const selection = `id, organization_id, name, interval_seconds, regions, health_state, version, config,
  failure_threshold, recovery_threshold, created_at, updated_at, created_by, updated_by`;

interface PageCursor {
  createdAt: string;
  id: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeCursor(value: string): PageCursor {
  try {
    const decoded = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<PageCursor>;
    if (
      typeof decoded.createdAt !== "string"
      || Number.isNaN(Date.parse(decoded.createdAt))
      || typeof decoded.id !== "string"
      || !uuidPattern.test(decoded.id)
    ) throw new Error("invalid cursor");
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new BadRequestException({ code: "INVALID_CURSOR", message: "Monitor cursor is invalid" });
  }
}

function encodeCursor(row: MonitorRow): string {
  return Buffer.from(JSON.stringify({ createdAt: new Date(row.created_at).toISOString(), id: row.id })).toString("base64url");
}

@Injectable()
export class MonitorsService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
  ) {}

  async list(organizationId: string, userId: string, limit: number, rawCursor?: string): Promise<{ items: Monitor[]; nextCursor: string | null }> {
    await this.organizations.membership(organizationId, userId);
    const cursor = rawCursor ? decodeCursor(rawCursor) : undefined;
    const result = cursor
      ? await this.pool.query<MonitorRow>(
        `SELECT ${selection} FROM monitors
         WHERE deleted_at IS NULL AND organization_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
         ORDER BY created_at DESC, id DESC LIMIT $4`,
        [organizationId, cursor.createdAt, cursor.id, limit + 1],
      )
      : await this.pool.query<MonitorRow>(
        `SELECT ${selection} FROM monitors WHERE deleted_at IS NULL AND organization_id = $1 ORDER BY created_at DESC, id DESC LIMIT $2`,
        [organizationId, limit + 1],
      );
    const hasMore = result.rows.length > limit;
    const pageRows = result.rows.slice(0, limit);
    return { items: pageRows.map(toMonitor), nextCursor: hasMore ? encodeCursor(pageRows.at(-1)!) : null };
  }

  async get(organizationId: string, userId: string, id: string): Promise<Monitor> {
    await this.organizations.membership(organizationId, userId);
    const result = await this.pool.query<MonitorRow>(
      `SELECT ${selection} FROM monitors WHERE deleted_at IS NULL AND organization_id = $1 AND id = $2`,
      [organizationId, id],
    );
    if (!result.rowCount) throw new NotFoundException({ code: "MONITOR_NOT_FOUND", message: "Monitor not found" });
    return toMonitor(result.rows[0]!);
  }

  async create(organizationId: string, userId: string, input: MonitorInput): Promise<Monitor> {
    await this.organizations.requireMonitorWrite(organizationId, userId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const failureThreshold = input.incidentPolicy?.failureThreshold ?? 2;
      const recoveryThreshold = input.incidentPolicy?.recoveryThreshold ?? 2;
      const result = await client.query<MonitorRow>(
        `INSERT INTO monitors(organization_id, name, interval_seconds, regions, config, failure_threshold, recovery_threshold, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $8) RETURNING ${selection}`,
        [organizationId, input.name, input.intervalSeconds, input.regions, input.config, failureThreshold, recoveryThreshold, userId],
      );
      const monitor = result.rows[0]!;
      await this.insertVersion(client, monitor, userId);
      await client.query("COMMIT");
      return toMonitor(monitor);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(organizationId: string, userId: string, id: string, input: MonitorUpdateInput): Promise<Monitor> {
    await this.organizations.requireMonitorWrite(organizationId, userId);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const failureThreshold = input.incidentPolicy?.failureThreshold;
      const recoveryThreshold = input.incidentPolicy?.recoveryThreshold;
      const result = await client.query<MonitorRow>(
        `UPDATE monitors SET name = $3, interval_seconds = $4, regions = $5, config = $6,
           failure_threshold = COALESCE($7, failure_threshold),
           recovery_threshold = COALESCE($8, recovery_threshold),
           version = version + 1, updated_by = $9, updated_at = now()
         WHERE deleted_at IS NULL AND organization_id = $1 AND id = $2 AND version = $10 RETURNING ${selection}`,
        [organizationId, id, input.name, input.intervalSeconds, input.regions, input.config, failureThreshold ?? null, recoveryThreshold ?? null, userId, input.version],
      );
      if (!result.rowCount) {
        const exists = await client.query("SELECT version FROM monitors WHERE deleted_at IS NULL AND organization_id = $1 AND id = $2", [organizationId, id]);
        if (!exists.rowCount) throw new NotFoundException({ code: "MONITOR_NOT_FOUND", message: "Monitor not found" });
        throw new ConflictException({ code: "VERSION_CONFLICT", message: "Monitor was changed by another request", details: { currentVersion: exists.rows[0].version } });
      }
      const monitor = result.rows[0]!;
      await this.insertVersion(client, monitor, userId);
      await client.query("COMMIT");
      return toMonitor(monitor);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getTimeseries(
    organizationId: string,
    userId: string,
    monitorId: string,
    window: string = "24h",
  ): Promise<import("@argus/contracts").MonitorTimeSeriesResponse> {
    await this.organizations.membership(organizationId, userId);
    const monitor = await this.pool.query("SELECT id FROM monitors WHERE deleted_at IS NULL AND organization_id = $1 AND id = $2", [organizationId, monitorId]);
    if (!monitor.rowCount) throw new NotFoundException({ code: "MONITOR_NOT_FOUND", message: "Monitor not found" });

    const windowHours = window === "1h" ? 1 : window === "6h" ? 6 : 24;
    const to = new Date();
    const from = new Date(to.getTime() - windowHours * 3600 * 1000);

    const query = `
      SELECT
        t.region,
        e.id AS execution_id,
        e.scheduled_at,
        e.kind,
        COALESCE(r.result->>'outcome', CASE WHEN t.status = 'COMPLETED' THEN 'PASS' WHEN t.status = 'EXPIRED' THEN 'FAIL' ELSE NULL END) AS outcome,
        (r.result->>'durationMs')::int AS latency_ms
      FROM executions e
      JOIN execution_targets t ON t.execution_id = e.id AND t.organization_id = e.organization_id
      LEFT JOIN probe_results r ON r.target_id = t.id AND r.organization_id = t.organization_id
      WHERE e.organization_id = $1
        AND e.monitor_id = $2
        AND e.scheduled_at >= $3
        AND e.scheduled_at <= $4
      ORDER BY e.scheduled_at ASC, e.sequence ASC
      LIMIT 15001
    `;
    const res = await this.pool.query(query, [organizationId, monitorId, from, to]);
    const truncated = res.rows.length > 15000;
    const points = truncated ? res.rows.slice(0, 15000) : res.rows;

    const series: Record<string, import("@argus/contracts").TimeSeriesPoint[]> = {};
    for (const row of points) {
      const list = series[row.region] ?? (series[row.region] = []);
      list.push({
        executionId: row.execution_id,
        time: new Date(row.scheduled_at).toISOString(),
        kind: row.kind,
        outcome: row.outcome ?? null,
        latencyMs: row.latency_ms !== null && row.latency_ms !== undefined ? Number(row.latency_ms) : null,
      });
    }

    return {
      monitorId,
      from: from.toISOString(),
      to: to.toISOString(),
      truncated,
      series,
    };
  }

  async delete(organizationId: string, userId: string, id: string): Promise<void> {
    await this.organizations.requireMonitorWrite(organizationId, userId);
    const result = await this.pool.query("UPDATE monitors SET deleted_at=now(),updated_at=now() WHERE deleted_at IS NULL AND organization_id = $1 AND id = $2", [organizationId, id]);
    if (!result.rowCount) throw new NotFoundException({ code: "MONITOR_NOT_FOUND", message: "Monitor not found" });
  }

  private async insertVersion(client: PoolClient, row: MonitorRow, userId: string): Promise<void> {
    await client.query(
      `INSERT INTO monitor_versions(organization_id, monitor_id, version, name, interval_seconds, regions, config, changed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [row.organization_id, row.id, row.version, row.name, row.interval_seconds, row.regions, row.config, userId],
    );
  }
}
