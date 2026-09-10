import { Pool } from "pg";
import { resolveDatabaseUrl } from "../database/database-url";
import { backfillRawHistory, maintainRawPartitions } from "./raw-history";

async function main() {
  const connectionString = await resolveDatabaseUrl();
  const pool = new Pool({ connectionString });
  try {
    await maintainRawPartitions(pool);
    let total = 0;
    for (;;) { const count = await backfillRawHistory(pool); total += count; if (!count) break; }
    console.log(JSON.stringify({ event: "raw_backfill_completed", inserted: total }));
  } finally { await pool.end(); }
}
main().catch(() => { console.error("Raw backfill failed; check migrations and database connectivity"); process.exitCode = 1; });
