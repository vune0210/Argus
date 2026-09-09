import { Controller, Get, Inject, Param, ParseUUIDPipe, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import type { Pool } from "pg";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { AuthGuard } from "../auth/auth.guard";
import type { ArgusRequest } from "../common/request";
import { DATABASE_POOL } from "../database/database.module";
import { OrganizationsService } from "../organizations/organizations.service";

@Controller("api/v1/organizations")
@UseGuards(AuthGuard)
export class EventsController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool,
    @Inject(OrganizationsService) private readonly organizations: OrganizationsService) {}

  @Get(":organizationId/events")
  async events(@Param("organizationId", ParseUUIDPipe) organizationId: string, @Req() req: ArgusRequest, @Res() res: Response): Promise<void> {
    await this.organizations.membership(organizationId, req.identity!.id);
    const last = req.header("Last-Event-ID");
    let cursor = "0";
    let resync = false;
    if (last) {
      const found = await this.pool.query("SELECT sequence FROM domain_events WHERE id::text=$1 AND organization_id=$2 AND occurred_at>=now()-interval '24 hours'", [last, organizationId]);
      if (found.rows[0]) cursor = found.rows[0].sequence;
      else resync = true;
    }
    if (!last || resync) {
      cursor = (await this.pool.query("SELECT COALESCE(max(sequence),0)::text AS cursor FROM domain_events WHERE organization_id=$1", [organizationId])).rows[0].cursor;
    }
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    let closed = false;
    const onClose = () => { closed = true; };
    res.on("close", onClose);
    const started = Date.now();
    const send = (type: string, data: unknown, id?: string) => res.write(`${id ? `id: ${id}\n` : ""}event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    try {
      // Snapshot was fetched before opening SSE; initial resync closes that race too.
      if (!last || resync) send("system.resync_required", { id: randomUUID(), type: "system.resync_required", version: 1,
        organizationId, occurredAt: new Date().toISOString(), correlationId: randomUUID(), payload: {} });
      while (!closed && Date.now() - started < 300_000) {
        await this.organizations.membership(organizationId, req.identity!.id);
        // PostgreSQL is the replay authority. Redis domain stream is a durable-outbox fanout feed;
        // bounded polling also delivers committed events while Redis is temporarily unavailable.
        const events = await this.pool.query("SELECT sequence,envelope FROM domain_events WHERE organization_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100", [organizationId, cursor]);
        for (const row of events.rows) {
          if (!send(row.envelope.type, row.envelope, row.envelope.id)) { closed = true; break; }
          cursor = row.sequence;
        }
        if (!events.rows.length) res.write(": heartbeat\n\n");
        if (!closed) await delay(events.rows.length === 100 ? 0 : 1000);
      }
    } catch { /* Terminate on auth revocation/storage failure; client reconnects with its last ID. */ }
    finally { res.off("close", onClose); res.end(); }
  }
}
