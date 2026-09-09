import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

@Controller("health")
export class HealthController {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  @Get("live")
  live(): { status: "ok"; service: string; timestamp: string } {
    return { status: "ok", service: "argus-api", timestamp: new Date().toISOString() };
  }

  @Get("ready")
  async ready(): Promise<{ status: "ok"; service: string; timestamp: string }> {
    try {
      await this.pool.query("SELECT 1");
      return { status: "ok", service: "argus-api", timestamp: new Date().toISOString() };
    } catch {
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE", message: "PostgreSQL is unavailable" });
    }
  }
}
