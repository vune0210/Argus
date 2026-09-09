import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { Pool, PoolClient } from "pg";
import type {
  CreateStatusPageRequest,
  PublicIncident,
  PublicStatusComponent,
  PublicStatusPage,
  StatusPage,
  StatusPageComponent,
  StatusPageSummary,
  UpdateStatusPageRequest,
} from "@argus/contracts";
import { DATABASE_POOL } from "../database/database.module";
import { OrganizationsService } from "../organizations/organizations.service";

const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export type InternalHealth =
  | "HEALTHY"
  | "DEGRADED"
  | "PENDING_DOWN"
  | "DOWN"
  | "PENDING_RECOVERY"
  | "UNKNOWN";

export type PublicComponentStatus =
  | "OPERATIONAL"
  | "DEGRADED"
  | "MAJOR_OUTAGE"
  | "UNKNOWN";

export function mapHealthToPublicStatus(health: string | null | undefined): PublicComponentStatus {
  switch (health) {
    case "HEALTHY":
      return "OPERATIONAL";
    case "DEGRADED":
    case "PENDING_DOWN":
    case "PENDING_RECOVERY":
      return "DEGRADED";
    case "DOWN":
      return "MAJOR_OUTAGE";
    default:
      return "UNKNOWN";
  }
}

export function calculateOverallStatus(statuses: PublicComponentStatus[]): PublicComponentStatus {
  if (statuses.includes("MAJOR_OUTAGE")) return "MAJOR_OUTAGE";
  if (statuses.includes("DEGRADED")) return "DEGRADED";
  if (statuses.includes("UNKNOWN")) return "UNKNOWN";
  return "OPERATIONAL";
}

@Injectable()
export class StatusPagesService {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService,
  ) {}

  async listStatusPages(organizationId: string, userId: string): Promise<{ items: StatusPageSummary[] }> {
    await this.organizations.membership(organizationId, userId);

    const query = `
      SELECT 
        sp.id,
        sp.name,
        sp.slug,
        sp.published,
        sp.version,
        COUNT(c.id)::int AS component_count
      FROM status_pages sp
      LEFT JOIN status_page_components c ON c.status_page_id = sp.id AND c.organization_id = sp.organization_id
      WHERE sp.organization_id = $1 AND sp.deleted_at IS NULL
      GROUP BY sp.id
      ORDER BY sp.created_at DESC
    `;
    const res = await this.pool.query(query, [organizationId]);
    return {
      items: res.rows.map((r) => ({
        id: r.id,
        name: r.name,
        slug: r.slug,
        published: r.published,
        version: r.version,
        componentCount: r.component_count,
      })),
    };
  }

  async getStatusPage(organizationId: string, userId: string, id: string): Promise<StatusPage> {
    await this.organizations.membership(organizationId, userId);

    const pageRes = await this.pool.query(
      `SELECT * FROM status_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL`,
      [id, organizationId],
    );
    if (!pageRes.rowCount) {
      throw new NotFoundException({ code: "STATUS_PAGE_NOT_FOUND", message: "Status page not found" });
    }
    const page = pageRes.rows[0]!;

    const componentsRes = await this.pool.query(
      `SELECT * FROM status_page_components 
       WHERE status_page_id = $1 AND organization_id = $2 
       ORDER BY position ASC`,
      [id, organizationId],
    );

    return this.mapStatusPage(page, componentsRes.rows);
  }

  async createStatusPage(
    organizationId: string,
    userId: string,
    body: CreateStatusPageRequest,
  ): Promise<StatusPage> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (name.length < 1 || name.length > 120) {
      throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "name must contain 1-120 characters" });
    }

    const rawSlug = typeof body?.slug === "string" ? body.slug.trim().toLowerCase() : "";
    if (rawSlug.length < 3 || rawSlug.length > 63 || !SLUG_REGEX.test(rawSlug)) {
      throw new BadRequestException({
        code: "INVALID_PAYLOAD",
        message: "slug must contain 3-63 lowercase alphanumeric characters and hyphens",
      });
    }

    const published = Boolean(body?.published);
    const components = Array.isArray(body?.components) ? body.components : [];

    if (published && components.length === 0) {
      throw new BadRequestException({
        code: "INVALID_PAYLOAD",
        message: "A published status page must have at least one component",
      });
    }

    const seenMonitors = new Set<string>();
    for (const comp of components) {
      if (!comp.monitorId || typeof comp.monitorId !== "string") {
        throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Invalid monitorId" });
      }
      if (seenMonitors.has(comp.monitorId)) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: `Duplicate monitor ${comp.monitorId} in components`,
        });
      }
      seenMonitors.add(comp.monitorId);

      const publicName = typeof comp.publicName === "string" ? comp.publicName.trim() : "";
      if (publicName.length < 1 || publicName.length > 80) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "publicName must contain 1-80 characters",
        });
      }
    }

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Check slug collision (case-insensitive across active pages)
      const slugCheck = await client.query(
        `SELECT id FROM status_pages WHERE LOWER(slug) = LOWER($1) AND deleted_at IS NULL LIMIT 1`,
        [rawSlug],
      );
      if (slugCheck.rowCount) {
        throw new ConflictException({
          code: "STATUS_PAGE_SLUG_CONFLICT",
          message: `Status page slug "${rawSlug}" is already in use`,
        });
      }

      // Validate all components
      await this.validateComponents(client, organizationId, components);

      const pageRes = await client.query(
        `INSERT INTO status_pages (organization_id, name, slug, description, published, version, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, 1, $6, $6)
         RETURNING *`,
        [organizationId, name, rawSlug, body.description ?? null, published, userId],
      );
      const page = pageRes.rows[0]!;

      const insertedComponents: any[] = [];
      for (let i = 0; i < components.length; i++) {
        const comp = components[i]!;
        const compRes = await client.query(
          `INSERT INTO status_page_components (organization_id, status_page_id, monitor_id, public_name, position)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [organizationId, page.id, comp.monitorId, comp.publicName.trim(), i],
        );
        insertedComponents.push(compRes.rows[0]!);
      }

      await client.query("COMMIT");
      return this.mapStatusPage(page, insertedComponents);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async updateStatusPage(
    organizationId: string,
    userId: string,
    id: string,
    body: UpdateStatusPageRequest,
  ): Promise<StatusPage> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    if (body.version === undefined || !Number.isInteger(body.version)) {
      throw new BadRequestException({
        code: "INVALID_PAYLOAD",
        message: "version is required for optimistic locking",
      });
    }

    const client: PoolClient = await this.pool.connect();
    try {
      await client.query("BEGIN");

      const currentRes = await client.query(
        `SELECT * FROM status_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL FOR UPDATE`,
        [id, organizationId],
      );
      if (!currentRes.rowCount) {
        throw new NotFoundException({ code: "STATUS_PAGE_NOT_FOUND", message: "Status page not found" });
      }
      const current = currentRes.rows[0]!;

      if (current.version !== body.version) {
        throw new ConflictException({
          code: "VERSION_CONFLICT",
          message: "Version conflict: status page was modified by another operation",
        });
      }

      let name = current.name;
      if (body.name !== undefined) {
        name = typeof body.name === "string" ? body.name.trim() : "";
        if (name.length < 1 || name.length > 120) {
          throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "name must contain 1-120 characters" });
        }
      }

      let slug = current.slug;
      if (body.slug !== undefined) {
        const rawSlug = typeof body.slug === "string" ? body.slug.trim().toLowerCase() : "";
        if (rawSlug.length < 3 || rawSlug.length > 63 || !SLUG_REGEX.test(rawSlug)) {
          throw new BadRequestException({
            code: "INVALID_PAYLOAD",
            message: "slug must contain 3-63 lowercase alphanumeric characters and hyphens",
          });
        }
        if (rawSlug !== current.slug.toLowerCase()) {
          const slugCheck = await client.query(
            `SELECT id FROM status_pages WHERE LOWER(slug) = LOWER($1) AND deleted_at IS NULL AND id != $2 LIMIT 1`,
            [rawSlug, id],
          );
          if (slugCheck.rowCount) {
            throw new ConflictException({
              code: "STATUS_PAGE_SLUG_CONFLICT",
              message: `Status page slug "${rawSlug}" is already in use`,
            });
          }
          slug = rawSlug;
        }
      }

      const published = body.published !== undefined ? Boolean(body.published) : current.published;
      const description = body.description !== undefined ? body.description : current.description;

      let componentsToPersist = body.components;
      if (componentsToPersist === undefined) {
        const existingComps = await client.query(
          `SELECT monitor_id AS "monitorId", public_name AS "publicName" FROM status_page_components 
           WHERE status_page_id = $1 AND organization_id = $2 ORDER BY position ASC`,
          [id, organizationId],
        );
        componentsToPersist = existingComps.rows;
      }

      if (published && componentsToPersist.length === 0) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "A published status page must have at least one component",
        });
      }

      await this.validateComponents(client, organizationId, componentsToPersist);

      // Atomically replace components
      await client.query(
        `DELETE FROM status_page_components WHERE status_page_id = $1 AND organization_id = $2`,
        [id, organizationId],
      );

      const insertedComponents: any[] = [];
      for (let i = 0; i < componentsToPersist.length; i++) {
        const comp = componentsToPersist[i]!;
        const compRes = await client.query(
          `INSERT INTO status_page_components (organization_id, status_page_id, monitor_id, public_name, position)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [organizationId, id, comp.monitorId, comp.publicName.trim(), i],
        );
        insertedComponents.push(compRes.rows[0]!);
      }

      const nextVersion = current.version + 1;
      const updateRes = await client.query(
        `UPDATE status_pages
         SET name = $3, slug = $4, description = $5, published = $6,
             version = $7, updated_by = $8, updated_at = now()
         WHERE id = $1 AND organization_id = $2
         RETURNING *`,
        [id, organizationId, name, slug, description, published, nextVersion, userId],
      );

      await client.query("COMMIT");
      return this.mapStatusPage(updateRes.rows[0]!, insertedComponents);
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteStatusPage(organizationId: string, userId: string, id: string): Promise<void> {
    await this.organizations.requireMonitorWrite(organizationId, userId);

    const res = await this.pool.query(
      `UPDATE status_pages
       SET deleted_at = now(), updated_at = now(), updated_by = $3
       WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [id, organizationId, userId],
    );

    if (!res.rowCount) {
      throw new NotFoundException({ code: "STATUS_PAGE_NOT_FOUND", message: "Status page not found" });
    }
  }

  // --- Public Read Model ---
  async getPublicStatusPage(slug: string): Promise<PublicStatusPage> {
    const rawSlug = String(slug || "").trim().toLowerCase();

    // Query 1: Page & components + monitors health_state (1 roundtrip)
    const pageRes = await this.pool.query(
      `SELECT id, organization_id, name, slug, description, updated_at
       FROM status_pages
       WHERE LOWER(slug) = LOWER($1) AND deleted_at IS NULL AND published = true`,
      [rawSlug],
    );

    if (!pageRes.rowCount) {
      throw new NotFoundException({ code: "STATUS_PAGE_NOT_FOUND", message: "Status page not found" });
    }
    const page = pageRes.rows[0]!;

    const compRes = await this.pool.query(
      `SELECT 
         c.id AS component_id,
         c.public_name,
         c.position,
         c.monitor_id,
         m.health_state
       FROM status_page_components c
       JOIN monitors m ON m.id = c.monitor_id AND m.organization_id = c.organization_id
       WHERE c.status_page_id = $1 AND m.deleted_at IS NULL
       ORDER BY c.position ASC`,
      [page.id],
    );

    const components = compRes.rows;
    if (components.length === 0) {
      // If no valid active monitors remain, overall status is OPERATIONAL or UNKNOWN
      return {
        name: page.name,
        slug: page.slug,
        description: page.description,
        overallStatus: "OPERATIONAL",
        updatedAt: page.updated_at.toISOString(),
        components: [],
        incidents: [],
      };
    }

    const monitorIds = components.map((c) => c.monitor_id);

    // Query 2: Aggregated uptime/coverage across 24h, 7d, 30d for all monitors (1 roundtrip, no N+1)
    const statsRes = await this.pool.query(
      `SELECT 
         e.monitor_id,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '24 hours') AS total_24h,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '24 hours' AND e.observation != 'INSUFFICIENT_RESULTS') AS valid_24h,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '24 hours' AND e.observation IN ('QUORUM_PASS', 'SINGLE_REGION_FAILURE')) AS avail_24h,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '7 days') AS total_7d,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '7 days' AND e.observation != 'INSUFFICIENT_RESULTS') AS valid_7d,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '7 days' AND e.observation IN ('QUORUM_PASS', 'SINGLE_REGION_FAILURE')) AS avail_7d,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '30 days') AS total_30d,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '30 days' AND e.observation != 'INSUFFICIENT_RESULTS') AS valid_30d,
         COUNT(*) FILTER (WHERE e.scheduled_at >= now() - interval '30 days' AND e.observation IN ('QUORUM_PASS', 'SINGLE_REGION_FAILURE')) AS avail_30d
       FROM executions e
       WHERE e.monitor_id = ANY($1::uuid[])
         AND e.kind = 'SCHEDULED'
         AND e.completed_at IS NOT NULL
         AND e.scheduled_at >= now() - interval '30 days'
       GROUP BY e.monitor_id`,
      [monitorIds],
    );

    const statsByMonitor = new Map<string, any>();
    for (const row of statsRes.rows) {
      statsByMonitor.set(row.monitor_id, row);
    }

    // Query 3: Incidents for these components (up to 20 latest)
    const incRes = await this.pool.query(
      `SELECT 
         i.status,
         i.opened_at,
         i.resolved_at,
         c.public_name AS component_name
       FROM incidents i
       JOIN status_page_components c ON c.monitor_id = i.monitor_id AND c.status_page_id = $1
       WHERE i.organization_id = $2
       ORDER BY i.opened_at DESC
       LIMIT 20`,
      [page.id, page.organization_id],
    );

    const publicComponents: PublicStatusComponent[] = [];
    const componentStatuses: PublicComponentStatus[] = [];

    for (const comp of components) {
      const compStatus = mapHealthToPublicStatus(comp.health_state);
      componentStatuses.push(compStatus);

      const stats = statsByMonitor.get(comp.monitor_id);

      const calc = (total: number, valid: number, avail: number) => {
        const coverage = total > 0 ? Number(((valid / total) * 100).toFixed(2)) : 0;
        const uptime = valid > 0 ? Number(((avail / valid) * 100).toFixed(2)) : null;
        return { uptime, coverage };
      };

      const w24 = calc(
        Number(stats?.total_24h || 0),
        Number(stats?.valid_24h || 0),
        Number(stats?.avail_24h || 0),
      );
      const w7d = calc(
        Number(stats?.total_7d || 0),
        Number(stats?.valid_7d || 0),
        Number(stats?.avail_7d || 0),
      );
      const w30d = calc(
        Number(stats?.total_30d || 0),
        Number(stats?.valid_30d || 0),
        Number(stats?.avail_30d || 0),
      );

      publicComponents.push({
        name: comp.public_name,
        status: compStatus,
        uptime: {
          last24Hours: w24.uptime,
          last7Days: w7d.uptime,
          last30Days: w30d.uptime,
        },
        coverage: {
          last24Hours: w24.coverage,
          last7Days: w7d.coverage,
          last30Days: w30d.coverage,
        },
      });
    }

    const publicIncidents: PublicIncident[] = incRes.rows.map((r) => ({
      componentName: r.component_name,
      status: r.status,
      openedAt: r.opened_at.toISOString(),
      resolvedAt: r.resolved_at ? r.resolved_at.toISOString() : null,
    }));

    const overallStatus = calculateOverallStatus(componentStatuses);

    return {
      name: page.name,
      slug: page.slug,
      description: page.description,
      overallStatus,
      updatedAt: page.updated_at.toISOString(),
      components: publicComponents,
      incidents: publicIncidents,
    };
  }

  private async validateComponents(
    client: PoolClient,
    organizationId: string,
    components: Array<{ monitorId: string; publicName: string }>,
  ): Promise<void> {
    if (!components.length) return;

    const seenMonitors = new Set<string>();
    for (const comp of components) {
      if (!comp.monitorId || typeof comp.monitorId !== "string") {
        throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Invalid monitorId" });
      }
      if (seenMonitors.has(comp.monitorId)) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: `Duplicate monitor ${comp.monitorId} in components`,
        });
      }
      seenMonitors.add(comp.monitorId);

      const publicName = typeof comp.publicName === "string" ? comp.publicName.trim() : "";
      if (publicName.length < 1 || publicName.length > 80) {
        throw new BadRequestException({
          code: "INVALID_PAYLOAD",
          message: "publicName must contain 1-80 characters",
        });
      }
    }

    // Verify all monitors belong to same organization and are not deleted
    const monitorIds = Array.from(seenMonitors);
    const existingRes = await client.query(
      `SELECT id FROM monitors WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND deleted_at IS NULL`,
      [monitorIds, organizationId],
    );

    if (existingRes.rowCount !== monitorIds.length) {
      throw new NotFoundException({
        code: "MONITOR_NOT_FOUND",
        message: "One or more monitors not found or belonging to another organization",
      });
    }
  }

  private mapStatusPage(row: any, componentRows: any[]): StatusPage {
    return {
      id: row.id,
      organizationId: row.organization_id,
      name: row.name,
      slug: row.slug,
      description: row.description ?? null,
      published: row.published,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      components: componentRows.map((c) => ({
        id: c.id,
        statusPageId: c.status_page_id,
        monitorId: c.monitor_id,
        publicName: c.public_name,
        position: c.position,
      })),
    };
  }

  async addComponent(
    organizationId: string,
    userId: string,
    statusPageId: string,
    body: import("@argus/contracts").AddStatusPageComponentRequest,
  ): Promise<StatusPageComponent> {
    await this.organizations.requireMonitorWrite(organizationId, userId);
    const monitorId = typeof body?.monitorId === "string" ? body.monitorId.trim() : "";
    const publicName = typeof body?.publicName === "string" ? body.publicName.trim() : "";
    if (!monitorId || !publicName || publicName.length > 80) {
      throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "monitorId and publicName (1-80 chars) are required" });
    }
    const page = await this.pool.query(
      "SELECT id FROM status_pages WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
      [statusPageId, organizationId],
    );
    if (!page.rowCount) throw new NotFoundException({ code: "STATUS_PAGE_NOT_FOUND", message: "Status page not found" });

    const monitor = await this.pool.query(
      "SELECT id FROM monitors WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL",
      [monitorId, organizationId],
    );
    if (!monitor.rowCount) throw new BadRequestException({ code: "INVALID_PAYLOAD", message: "Monitor does not exist" });

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query(
        "SELECT id FROM status_page_components WHERE status_page_id = $1 AND monitor_id = $2",
        [statusPageId, monitorId],
      );
      if (existing.rowCount) {
        throw new ConflictException({ code: "COMPONENT_EXISTS", message: "Monitor already added to this status page" });
      }

      const nextPosRes = await client.query(
        "SELECT COALESCE(MAX(position) + 1, 0) AS next_pos FROM status_page_components WHERE status_page_id = $1 AND organization_id = $2",
        [statusPageId, organizationId],
      );
      const position = body.displayOrder !== undefined ? body.displayOrder : nextPosRes.rows[0].next_pos;

      const res = await client.query(
        `INSERT INTO status_page_components(organization_id, status_page_id, monitor_id, public_name, position)
         VALUES($1, $2, $3, $4, $5) RETURNING *`,
        [organizationId, statusPageId, monitorId, publicName, position],
      );
      await client.query("COMMIT");
      const r = res.rows[0];
      return {
        id: r.id,
        statusPageId: r.status_page_id,
        monitorId: r.monitor_id,
        publicName: r.public_name,
        position: r.position,
        displayOrder: r.position,
      };
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async removeComponent(
    organizationId: string,
    userId: string,
    statusPageId: string,
    componentId: string,
  ): Promise<void> {
    await this.organizations.requireMonitorWrite(organizationId, userId);
    const res = await this.pool.query(
      "DELETE FROM status_page_components WHERE id = $1 AND status_page_id = $2 AND organization_id = $3",
      [componentId, statusPageId, organizationId],
    );
    if (!res.rowCount) {
      throw new NotFoundException({ code: "COMPONENT_NOT_FOUND", message: "Component not found" });
    }
  }
}
