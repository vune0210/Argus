import { Pool } from "pg";
import { readEnvironment } from "../config/environment";
import { digestToken, probeKey } from "./probe-auth";

async function main() {
  const id = process.env.ARGUS_PROBE_ID ?? "";
  const region = process.env.ARGUS_REGION ?? "";
  const token = process.env.ARGUS_TOKEN ?? "";
  const local = ["development","test"].includes(process.env.NODE_ENV ?? "development");
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || !/^[a-z0-9-]{2,32}$/.test(region)
    || !token.startsWith(`argp_${id}.`) || !/^[a-zA-Z0-9_-]{16,256}$/.test(token.slice(`argp_${id}.`.length))) throw new Error("Invalid probe registration parameters");
  if (!local && (id.startsWith("dev-") || token.endsWith(".local-development-secret"))) throw new Error("Development credentials are forbidden");
  const digest = digestToken(token,probeKey());
  const pool = new Pool({ connectionString: readEnvironment().databaseUrl });
  try {
    await pool.query(`INSERT INTO probe_agents(id,region,token_digest,is_development) VALUES($1,$2,$3,$4)
      ON CONFLICT(id) DO UPDATE SET token_digest=EXCLUDED.token_digest,status='ACTIVE'
      WHERE probe_agents.region=EXCLUDED.region AND probe_agents.is_development=EXCLUDED.is_development RETURNING id`, [id,region,digest,local])
      .then((result) => { if(!result.rowCount) throw new Error("Existing probe region/environment cannot be changed during rotation"); });
    console.log("Probe registered; only its HMAC digest was stored.");
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Probe registration failed; check parameters and environment");process.exitCode=1; });
