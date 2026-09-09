import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import type { Pool } from "pg";
import { DATABASE_POOL } from "../database/database.module";

export interface ProbeIdentity { id: string; region: string }
export type ProbeRequest = Request & { probe: ProbeIdentity };
export function digestToken(token: string, key: string): string {
  return createHmac("sha256", key).update(token).digest("hex");
}
export function probeKey(env: NodeJS.ProcessEnv = process.env): string {
  const local = ["development", "test"].includes(env.NODE_ENV ?? "development");
  const key = env.PROBE_TOKEN_HMAC_KEY ?? (local ? "local-development-hmac-key-not-for-production" : "");
  if (key.length < 32 || (!local && key === "local-development-hmac-key-not-for-production")) {
    throw new Error("PROBE_TOKEN_HMAC_KEY must be a private key of at least 32 characters");
  }
  if (!local && env.SEED_DEV_PROBES === "true") throw new Error("Development probe seeds are forbidden in this environment");
  return key;
}

@Injectable()
export class ProbeAuthGuard implements CanActivate {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProbeRequest>();
    const token = request.headers.authorization?.match(/^Bearer (argp_([a-zA-Z0-9-]{1,80})\.[a-zA-Z0-9_-]{16,256})$/);
    if (!token) throw new UnauthorizedException("Invalid probe credentials");
    const result = await this.pool.query("SELECT * FROM probe_agents WHERE id=$1 AND status='ACTIVE'", [token[2]]);
    const agent = result.rows[0];
    const local = ["development", "test"].includes(process.env.NODE_ENV ?? "development");
    const actual = Buffer.from(digestToken(token[1]!, probeKey()), "hex");
    const expected = Buffer.from(agent?.token_digest ?? "", "hex");
    if (!agent || (!local && agent.is_development) || actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new UnauthorizedException("Invalid probe credentials");
    }
    await this.pool.query("UPDATE probe_agents SET last_seen_at=now() WHERE id=$1", [agent.id]);
    request.probe = { id: agent.id, region: agent.region };
    return true;
  }
}

export async function seedDevelopmentProbes(pool: Pool): Promise<void> {
  const key = probeKey();
  if (process.env.SEED_DEV_PROBES !== "true") return;
  for (const region of ["ap-southeast-1", "ap-northeast-1", "eu-central-1"]) {
    const id = `dev-${region}`;
    await pool.query(`INSERT INTO probe_agents(id,region,token_digest,is_development) VALUES($1,$2,$3,true)
      ON CONFLICT(id) DO UPDATE SET token_digest=EXCLUDED.token_digest WHERE probe_agents.is_development=true`,
    [id, region, digestToken(`argp_${id}.local-development-secret`, key)]);
  }
}
