import { randomUUID } from "node:crypto";
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OrganizationsService } from "../organizations/organizations.service";
import type { MonitorInput } from "./monitor.validation";
import { MonitorsService } from "./monitors.service";

const integration = process.env.DATABASE_URL ? describe : describe.skip;

integration("monitor tenant integration", () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const organizations = new OrganizationsService(pool);
  const monitors = new MonitorsService(pool, organizations);
  const ownerId = `owner-${randomUUID()}`;
  const outsiderId = `outsider-${randomUUID()}`;
  const viewerId = `viewer-${randomUUID()}`;
  let organizationId: string;

  const input: MonitorInput = {
    name: "Integration API",
    intervalSeconds: 60,
    regions: ["ap-southeast-1", "ap-northeast-1", "eu-central-1"],
    config: {
      kind: "http",
      url: "https://example.com/health",
      method: "GET",
      timeoutMs: 5000,
      expectedStatus: 200,
      maxRedirects: 5,
      maxResponseBytes: 1_048_576,
    },
  };

  beforeAll(async () => {
    for (const [id, email] of [[ownerId, "owner@example.test"], [outsiderId, "outsider@example.test"], [viewerId, "viewer@example.test"]]) {
      await pool.query("INSERT INTO users(id, email) VALUES ($1, $2)", [id, email]);
    }
    const organization = await pool.query<{ id: string }>("INSERT INTO organizations(name, slug) VALUES ('Integration', $1) RETURNING id", [`integration-${randomUUID()}`]);
    organizationId = organization.rows[0]!.id;
    await pool.query("INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1, $2, 'OWNER'), ($1, $3, 'VIEWER')", [organizationId, ownerId, viewerId]);
  });

  afterAll(async () => {
    if (organizationId) {
      for (let i = 0; i < 5; i++) {
        try { await pool.query("DELETE FROM organizations WHERE id = $1", [organizationId]); break; }
        catch { await new Promise((r) => setTimeout(r, 200)); }
      }
    }
    await pool.query("DELETE FROM users WHERE id = ANY($1::text[])", [[ownerId, outsiderId, viewerId]]).catch(() => undefined);
    await pool.end();
  });

  it("prevents cross-tenant reads and viewer writes", async () => {
    const monitor = await monitors.create(organizationId, ownerId, input);
    await expect(monitors.get(organizationId, outsiderId, monitor.id)).rejects.toBeInstanceOf(NotFoundException);
    await expect(monitors.create(organizationId, viewerId, input)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("rejects stale optimistic versions", async () => {
    const monitor = await monitors.create(organizationId, ownerId, input);
    await monitors.update(organizationId, ownerId, monitor.id, { ...input, name: "Updated", version: monitor.version });
    await expect(monitors.update(organizationId, ownerId, monitor.id, { ...input, name: "Stale", version: monitor.version })).rejects.toBeInstanceOf(ConflictException);
  });

  it("paginates with an opaque cursor and rejects malformed cursors", async () => {
    await Promise.all(["Page A", "Page B", "Page C"].map((name) => monitors.create(organizationId, ownerId, { ...input, name })));
    const first = await monitors.list(organizationId, ownerId, 2);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = await monitors.list(organizationId, ownerId, 2, first.nextCursor!);
    expect(second.items.length).toBeGreaterThan(0);
    expect(second.items.some((candidate) => first.items.some((item) => item.id === candidate.id))).toBe(false);
    await expect(monitors.list(organizationId, ownerId, 2, "not-a-cursor")).rejects.toBeInstanceOf(BadRequestException);
    const invalidUuidCursor = Buffer.from(JSON.stringify({ createdAt: new Date().toISOString(), id: "not-a-uuid" })).toString("base64url");
    await expect(monitors.list(organizationId, ownerId, 2, invalidUuidCursor)).rejects.toBeInstanceOf(BadRequestException);
  });
});
