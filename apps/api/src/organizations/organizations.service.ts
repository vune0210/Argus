import { ForbiddenException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { BootstrapResponse, Role } from "@argus/contracts";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Identity } from "../common/request";
import { DATABASE_POOL } from "../database/database.module";

interface MembershipRow {
  id: string;
  name: string;
  role: Role;
}

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async bootstrap(identity: Identity): Promise<BootstrapResponse> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO users(id, email) VALUES ($1, $2)
         ON CONFLICT (id) DO UPDATE SET email = EXCLUDED.email, updated_at = now()`,
        [identity.id, identity.email],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [identity.id]);
      const membership = await client.query<MembershipRow>(
        `SELECT o.id, o.name, m.role
         FROM organization_members m
         JOIN organizations o ON o.id = m.organization_id
         WHERE m.user_id = $1
         ORDER BY m.created_at ASC
         LIMIT 1`,
        [identity.id],
      );
      let organization = membership.rows[0];
      if (!organization) {
        const localPart = identity.email.split("@")[0]?.replace(/[^a-z0-9]+/gi, " ").trim() || "Argus";
        const name = `${localPart} workspace`;
        const created = await client.query<{ id: string; name: string }>(
          "INSERT INTO organizations(name, slug) VALUES ($1, $2) RETURNING id, name",
          [name, `${localPart.toLowerCase().replace(/\s+/g, "-")}-${randomUUID().slice(0, 8)}`],
        );
        await client.query(
          "INSERT INTO organization_members(organization_id, user_id, role) VALUES ($1, $2, 'OWNER')",
          [created.rows[0]!.id, identity.id],
        );
        organization = { ...created.rows[0]!, role: "OWNER" };
      }
      await client.query("COMMIT");
      return { user: identity, organization };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async membership(organizationId: string, userId: string): Promise<Role> {
    const result = await this.pool.query<{ role: Role }>(
      "SELECT role FROM organization_members WHERE organization_id = $1 AND user_id = $2",
      [organizationId, userId],
    );
    if (!result.rowCount) throw new NotFoundException({ code: "ORGANIZATION_NOT_FOUND", message: "Organization not found" });
    return result.rows[0]!.role;
  }

  async requireMonitorWrite(organizationId: string, userId: string): Promise<Role> {
    const role = await this.membership(organizationId, userId);
    if (!(["OWNER", "ADMIN"] as Role[]).includes(role)) {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Owner or Admin role is required" });
    }
    return role;
  }

  async requireIncidentWrite(organizationId: string, userId: string): Promise<Role> {
    const role = await this.membership(organizationId, userId);
    if (!(["OWNER", "ADMIN", "RESPONDER"] as Role[]).includes(role)) {
      throw new ForbiddenException({ code: "INSUFFICIENT_ROLE", message: "Responder, Admin, or Owner role is required" });
    }
    return role;
  }
}
