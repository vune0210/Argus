import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
const { Pool } = require("pg");
if (!process.env.DATABASE_URL || process.env.NODE_ENV !== "test") throw new Error("Set NODE_ENV=test and DATABASE_URL to an isolated local test server");
const source = new URL(process.env.DATABASE_URL);
if (!["localhost", "127.0.0.1", "postgres"].includes(source.hostname)) throw new Error("Migration drill is restricted to a local test server");
const database = `argus_roundtrip_${randomUUID().replaceAll("-", "")}`;
const admin = new Pool({ connectionString: source.toString() });
let test;
try {
  await admin.query(`CREATE DATABASE ${database}`);
  source.pathname = `/${database}`;
  test = new Pool({ connectionString: source.toString() });
  const directory = new URL("../apps/api/src/database/migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".sql")).sort()) {
    await test.query(await readFile(new URL(file, directory), "utf8"));
  }
  const tables = async () => (await test.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows;
  const before = await tables();
  const client = await test.connect();
  try {
    await client.query("BEGIN");
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/008_multichannel_recovery_notifications.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/007_evaluation_thresholds.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/006_status_pages.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/005_incident_response.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/004_check_results.sql", import.meta.url), "utf8"));
    await client.query(await readFile(new URL("../apps/api/src/database/rollback/003_execution_pipeline.sql", import.meta.url), "utf8"));
    await client.query("COMMIT");
    await client.query(await readFile(new URL("003_execution_pipeline.sql", directory), "utf8"));
    await client.query(await readFile(new URL("004_check_results.sql", directory), "utf8"));
    await client.query(await readFile(new URL("005_incident_response.sql", directory), "utf8"));
    await client.query(await readFile(new URL("006_status_pages.sql", directory), "utf8"));
    await client.query(await readFile(new URL("007_evaluation_thresholds.sql", directory), "utf8"));
    await client.query(await readFile(new URL("008_multichannel_recovery_notifications.sql", directory), "utf8"));
  } finally { client.release(); }
  assert.deepEqual(await tables(), before);
  console.log("Empty database migration, week-four rollback and reapply passed.");
} finally {
  await test?.end();
  await admin.query(`DROP DATABASE IF EXISTS ${database}`);
  await admin.end();
}
