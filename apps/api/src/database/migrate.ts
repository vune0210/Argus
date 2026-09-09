import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { readEnvironment } from "../config/environment";

async function migrationDirectory(): Promise<string> {
  const candidates = [
    resolve(process.cwd(), "src/database/migrations"),
    resolve(process.cwd(), "dist/database/migrations"),
    resolve(process.cwd(), "apps/api/src/database/migrations"),
    resolve(process.cwd(), "apps/api/dist/database/migrations"),
  ];
  for (const candidate of candidates) {
    try {
      await readdir(candidate);
      return candidate;
    } catch {
      // Try the next supported working directory.
    }
  }
  throw new Error("Could not locate apps/api/src/database/migrations");
}

async function migrate(): Promise<void> {
  const pool = new Pool({ connectionString: readEnvironment().databaseUrl });
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtextextended('argus:migrations', 0))");
    await client.query("CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
    const directory = await migrationDirectory();
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    for (const file of files) {
      const existing = await client.query("SELECT 1 FROM schema_migrations WHERE name = $1", [file]);
      if (existing.rowCount) continue;
      const sql = await readFile(resolve(directory, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtextextended('argus:migrations', 0))");
    client.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
